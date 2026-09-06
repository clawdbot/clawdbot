import ConcurrencyExtras
import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClaw
@testable import OpenClawKit

extension GatewayConnectionControlTests {
    @Test @MainActor
    func `heartbeat push supersedes the pending initial read`() async throws {
        try await self.withHeartbeatFixture { fixture in
            let initial = try await fixture.start()
            fixture.push(initial, timestamp: 2000)
            try await fixture.waitUntil { fixture.control.lastHeartbeatEvent?.ts == 2000 }

            fixture.reply(initial, timestamp: 1000)
            _ = try await fixture.gateway.request(method: "health", params: nil, retryTransportFailures: false)
            let heartbeat = try #require(fixture.control.lastHeartbeatEvent)
            #expect(heartbeat.ts == 2000)
            #expect(heartbeat.status == "sent")
            #expect(heartbeat.preview == "Synthetic heartbeat")
            #expect(heartbeat.durationMs == 12)
            #expect(heartbeat.hasMedia == true)
            #expect(heartbeat.to == "synthetic-recipient")
            #expect(heartbeat.reason == "synthetic-reason")
            #expect(fixture.reads.value.count == 1)
        }
    }

    @Test(arguments: ["unavailable", "empty", "existing"]) @MainActor
    func `heartbeat status belongs to the selected Gateway`(replacement: String) async throws {
        try await self.withHeartbeatFixture { fixture in
            let first = try await fixture.start()
            fixture.reply(first, timestamp: 1000)
            try await fixture.waitUntil { fixture.control.lastHeartbeatEvent?.ts == 1000 }

            fixture.revision.setValue(2)
            #expect(fixture.control.lastHeartbeatEvent == nil)
            if replacement == "unavailable" {
                try await fixture.gateway.adoptSelectedEndpoint()
            } else {
                _ = try await fixture.gateway.request(method: "health", params: nil, retryTransportFailures: false)
                let second = try await fixture.waitForRead(index: 1)
                let timestamp: Int? = replacement == "existing" ? 3000 : nil
                fixture.reply(second, timestamp: timestamp)
                if timestamp != nil {
                    try await fixture.waitUntil { fixture.control.lastHeartbeatEvent?.ts == 3000 }
                }
                _ = try await fixture.gateway.request(method: "health", params: nil, retryTransportFailures: false)
                #expect(fixture.control.lastHeartbeatEvent?.ts == timestamp.map(Double.init))
            }

            await fixture.control.disconnect()
            #expect(fixture.control.lastHeartbeatEvent == nil)
        }
    }

    @Test @MainActor
    func `same Gateway reconnect retains heartbeat until its new initial read completes`() async throws {
        try await self.withHeartbeatFixture { fixture in
            let first = try await fixture.start()
            fixture.reply(first, timestamp: 1000)
            try await fixture.waitUntil { fixture.control.lastHeartbeatEvent?.ts == 1000 }
            let lease = try #require(await fixture.gateway.captureServerLease())
            first.socket.emitReceiveFailure()
            try await fixture.waitUntil { !fixture.gateway.serverLeaseMatchesCurrentState(lease) }
            #expect(fixture.control.lastHeartbeatEvent?.ts == 1000)

            let second = try await fixture.waitForRead(index: 1)
            #expect(fixture.control.lastHeartbeatEvent?.ts == 1000)
            fixture.reply(second, timestamp: nil)
            try await fixture.waitUntil { fixture.control.lastHeartbeatEvent == nil }
            #expect(fixture.reads.value.count == 2)
        }
    }

    @Test @MainActor
    func `disconnect retires a pending heartbeat read before reconnecting`() async throws {
        try await self.withHeartbeatFixture { fixture in
            let first = try await fixture.start()
            await fixture.control.disconnect()
            #expect(await fixture.gateway.captureServerLease() == nil)

            _ = try await fixture.control.request(method: "health", retryTransportFailures: false)
            let second = try await fixture.waitForRead(index: 1)
            fixture.reply(first, timestamp: 1000)
            fixture.reply(second, timestamp: 3000)
            try await fixture.waitUntil { fixture.control.lastHeartbeatEvent?.ts == 3000 }
            #expect(fixture.reads.value.count == 2)
        }
    }

    @MainActor
    private func withHeartbeatFixture(_ body: (HeartbeatGatewayFixture) async throws -> Void) async throws {
        try await TestIsolation.withIsolatedState {
            let fixture = HeartbeatGatewayFixture()
            do {
                try await body(fixture)
            } catch {
                await fixture.stop()
                throw error
            }
            await fixture.stop()
        }
    }
}

@MainActor
private final class HeartbeatGatewayFixture {
    struct Read: Sendable {
        let id: String
        let socket: GatewayTestWebSocketTask
    }

    let revision = LockIsolated<UInt64>(1)
    let reads = LockIsolated<[Read]>([])
    let gateway: GatewayConnection
    let control: ControlChannel
    private let previousMode = AppStateStore.shared.connectionMode
    private let previousAccent = AppStateStore.shared.profileAccentHex
    private let previousMainKey = WorkActivityStore.shared.mainSessionKey

    init() {
        AppStateStore.shared.connectionMode = .unconfigured
        let revision = self.revision
        let reads = self.reads
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { socket, message, sendIndex in
                guard sendIndex > 0,
                      let data = GatewayConnectionControlTests.messageData(message),
                      let frame = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let id = frame["id"] as? String
                else { return }
                if frame["method"] as? String == "last-heartbeat" {
                    reads.withValue { $0.append(Read(id: id, socket: socket)) }
                } else {
                    socket.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
                }
            })
        })
        self.gateway = GatewayConnection(
            testEndpointProvider: {
                let selected = revision.value
                return GatewayConnection.EndpointSnapshot(
                    config: (URL(string: "ws://127.0.0.1:\(49300 + selected)")!, nil, nil),
                    routeAuthority: nil,
                    revision: selected)
            },
            currentEndpointRevision: { revision.value },
            sessionBox: WebSocketSessionBox(session: session))
        self.control = ControlChannel(gateway: self.gateway, endpointRevision: { revision.value })
    }

    func start() async throws -> Read {
        _ = try await self.gateway.request(method: "health", params: nil, retryTransportFailures: false)
        return try await self.waitForRead(index: 0)
    }

    func stop() async {
        await self.control.disconnect()
        AppStateStore.shared.connectionMode = self.previousMode
        AppStateStore.shared.profileAccentHex = self.previousAccent
        WorkActivityStore.shared.reset()
        WorkActivityStore.shared.setMainSessionKey(self.previousMainKey)
    }

    func waitForRead(index: Int) async throws -> Read {
        try await self.waitUntil { self.reads.value.count > index }
        return self.reads.value[index]
    }

    func waitUntil(_ condition: () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(2)
        while !condition(), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(2))
        }
        try #require(condition())
    }

    func reply(_ read: Read, timestamp: Int?) {
        let payload = timestamp.map(Self.payload) ?? "null"
        read.socket.emitReceiveSuccess(.data(Data(
            #"{"type":"res","id":"\#(read.id)","ok":true,"payload":\#(payload)}"#.utf8)))
    }

    func push(_ read: Read, timestamp: Int) {
        read.socket.emitReceiveSuccess(.data(Data(
            #"{"type":"event","event":"heartbeat","payload":\#(Self.payload(timestamp))}"#.utf8)))
    }

    private static func payload(_ timestamp: Int) -> String {
        #"{"ts":\#(timestamp),"status":"sent","preview":"Synthetic heartbeat","durationMs":12,"hasMedia":true,"to":"synthetic-recipient","reason":"synthetic-reason"}"#
    }
}
