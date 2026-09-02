import Foundation
import OpenClawKit
import OpenClawProtocol
import Testing
@testable import OpenClaw

private struct WorkerPipeTimeout: Error {
    let operation: String
}

private struct WorkerGatewayFrame: Decodable, Sendable {
    let type: String
    let generation: UInt64
    let connection: AnyCodable?
    let event: String?
    let payload: AnyCodable?
}

private final class WorkerGatewaySnapshotGate: WebSocketSessioning, GatewayTLSRouteMetadataProviding,
    @unchecked Sendable
{
    let transport = GatewayTestWebSocketSession()
    let entered = AsyncTestGate()
    private let releaseGate = DispatchSemaphore(value: 0)

    var effectiveTLSFingerprintSHA256: String? {
        self.entered.open()
        _ = self.releaseGate.wait(timeout: .now() + 5)
        return nil
    }

    func release() {
        self.releaseGate.signal()
    }

    func makeWebSocketTask(url: URL) -> WebSocketTaskBox {
        self.transport.makeWebSocketTask(url: url)
    }

    func makeWebSocketTask(request: URLRequest) -> WebSocketTaskBox {
        self.transport.makeWebSocketTask(request: request)
    }
}

@Suite(.serialized)
struct MacNodeHostWorkerPipeTests {
    @Test func `closed worker input cannot terminate the app with SIGPIPE`() async throws {
        let worker = MacNodeHostWorker(session: GatewayNodeSession())
        let script = """
        exec 0<&-
        printf '%s\\n' '{"type":"ready","version":"test","manifest":{"caps":[],"commands":[],"pathEnv":"/bin"}}'
        sleep 1
        """
        _ = try await worker.start(launch: MacNodeHostWorkerLaunch(
            command: ["/bin/sh", "-c", script]))

        let response = await worker.invoke(BridgeInvokeRequest(
            id: "closed",
            command: "system.run",
            paramsJSON: #"{"command":["/usr/bin/true"]}"#))

        #expect(!response.ok)
        await worker.stop()
    }

    @Test func `hosting connects before approval and forwards pairing events once with its generation`() async throws {
        let gateway = GatewayNodeSession()
        let transport = GatewayTestWebSocketSession()
        let worker = MacNodeHostWorker(session: gateway)
        do {
            _ = try await worker.start(launch: self.recordingLaunch())
            try await AsyncTimeout.withTimeout(
                seconds: 5,
                onTimeout: { WorkerPipeTimeout(operation: "first hosting connection without approval") },
                operation: {
                    try await self.connect(gateway, transport: transport, worker: worker)
                })
            let initialFrames = try await self.frames(from: worker)
            let connected = try #require(initialFrames.last { $0.connection != nil })
            #expect(initialFrames.filter { $0.type == "gateway-event" }.isEmpty)
            let route = try #require(await gateway.currentRoute())
            // A duplicate connected notification must not create a second subscriber.
            await worker.gatewayConnected(ifCurrentRoute: route)
            let socket = try #require(transport.latestTask())
            try await self.emit(event: "presence", requestId: "unrelated", socket: socket)

            for (index, decision) in ["approved", "rejected"].enumerated() {
                try await self.emit(decision: decision, requestId: decision, socket: socket)
                _ = try await self.waitForEvents(index + 1, worker: worker)
            }
            let frames = try await self.frames(from: worker)
            let events = frames.filter { $0.type == "gateway-event" }
            #expect(frames.filter { $0.connection != nil }.count == 1)
            #expect(events.count == 2)
            for (event, decision) in zip(events, ["approved", "rejected"]) {
                #expect(event.generation == connected.generation)
                #expect(event.event == "node.pair.resolved")
                #expect(event.payload == self.pairingPayload(requestId: decision, decision: decision))
            }
            #expect(transport.snapshotMakeCount() == 1)
        } catch {
            await worker.stop()
            await gateway.disconnect()
            throw error
        }
        await worker.stop()
        await gateway.disconnect()
    }

    @Test(arguments: [false, true])
    func `suspended connection and queued approval cannot adopt replacement ownership`(
        replaceWorker: Bool) async throws
    {
        let gateway = GatewayNodeSession()
        let snapshotGate = WorkerGatewaySnapshotGate()
        let worker = MacNodeHostWorker(session: gateway)
        var connecting: Task<Void, Never>?
        defer { snapshotGate.release() }
        do {
            _ = try await worker.start(launch: self.recordingLaunch())
            try await self.connect(gateway, transport: snapshotGate)
            let route = try #require(await gateway.currentRoute())
            #expect(await worker.setRoute(route, authorityGeneration: 1))
            connecting = Task { await worker.gatewayConnected(ifCurrentRoute: route) }
            try await AsyncTimeout.withTimeout(
                seconds: 5,
                onTimeout: { WorkerPipeTimeout(operation: "captured worker connection snapshot") },
                operation: { await snapshotGate.entered.wait() })
            let socket = try #require(snapshotGate.transport.latestTask())
            try await self.waitUntil("socket receive before queued approval") { socket.hasPendingReceiveHandler() }
            // The session actor is inside the metadata read. This socket event is
            // already queued, but cannot reach the subscriber until the owner changes.
            try socket.emitReceiveSuccessOnce(.data(self.eventData(requestId: "old-owner")))
            if replaceWorker {
                _ = try await worker.start(launch: self.recordingLaunch(configurationGeneration: 1))
            } else {
                #expect(await worker.setRoute(nil, authorityGeneration: 2))
            }
            #expect(await worker.setRoute(route, authorityGeneration: 3))
            snapshotGate.release()
            await connecting?.value
            try await self.waitUntil("queued approval drained") { socket.hasPendingReceiveHandler() }
            let staleFrames = try await self.frames(from: worker)
            #expect(staleFrames.allSatisfy { $0.type != "gateway-event" && $0.connection == nil })

            snapshotGate.release()
            await worker.gatewayConnected(ifCurrentRoute: route)
            try await self.emit(requestId: "current-owner", socket: socket)
            let events = try await self.waitForEvents(1, worker: worker)
            #expect(events.count == 1)
            #expect(events.first?.payload == self.pairingPayload(requestId: "current-owner"))
            let frames = try await self.frames(from: worker)
            #expect(events.first?.generation == frames.last { $0.connection != nil }?.generation)
        } catch {
            snapshotGate.release()
            await connecting?.value
            await worker.stop()
            await gateway.disconnect()
            throw error
        }
        await worker.stop()
        await gateway.disconnect()
    }

    @Test func `disconnect retires pairing subscription before the next gateway route`() async throws {
        let gateway = GatewayNodeSession()
        let transport = GatewayTestWebSocketSession()
        let worker = MacNodeHostWorker(session: gateway)
        do {
            _ = try await worker.start(launch: self.recordingLaunch())
            try await self.connect(gateway, transport: transport, worker: worker)
            let firstSocket = try #require(transport.latestTask())
            try await self.emit(requestId: "first-route", socket: firstSocket)
            let original = try await self.waitForEvents(1, worker: worker)
            await gateway.disconnect()
            try await self.connect(gateway, transport: transport, worker: worker, authorityGeneration: 2)
            let secondSocket = try #require(transport.latestTask())
            try await self.emit(requestId: "second-route", socket: secondSocket)
            let events = try await self.waitForEvents(2, worker: worker)
            #expect(events.count == 2)
            #expect(events.last?.generation != original.first?.generation)
            #expect(events.last?.payload == self.pairingPayload(requestId: "second-route"))
            #expect(transport.snapshotMakeCount() == 2)
        } catch {
            await worker.stop()
            await gateway.disconnect()
            throw error
        }
        await worker.stop()
        await gateway.disconnect()
    }

    private func recordingLaunch(configurationGeneration: UInt64 = 0) -> MacNodeHostWorkerLaunch {
        // Echo the actual input frames, not a mock of the worker's forwarding logic.
        let script = #"""
        printf '%s\n' '{"type":"ready","version":"test","manifest":{"caps":[],"commands":["test.inspect"],"pathEnv":"/bin"}}'
        frames=''
        separator=''
        while IFS= read -r line; do
          case "$line" in
            *'"type":"invoke"'*)
              generation=${line#*\"generation\":}
              generation=${generation%%[!0-9]*}
              printf '{"type":"invoke-result","generation":%s,"result":{"id":"inspect","ok":true,"payload":[%s]}}\n' "$generation" "$frames"
              ;;
            *) frames="$frames$separator$line"; separator=',' ;;
          esac
        done
        """#
        return MacNodeHostWorkerLaunch(
            command: ["/bin/sh", "-c", script],
            configurationGeneration: configurationGeneration)
    }

    private func connect(
        _ gateway: GatewayNodeSession,
        transport: any WebSocketSessioning,
        worker: MacNodeHostWorker? = nil,
        authorityGeneration: UInt64 = 1) async throws
    {
        try await gateway.connect(
            url: #require(URL(string: "ws://worker.example.invalid")),
            connectOptions: GatewayConnectOptions(
                role: "node", scopes: [], caps: [], commands: [], permissions: [:],
                clientId: "openclaw-macos", clientMode: "node",
                clientDisplayName: "macOS Worker Test", includeDeviceIdentity: false),
            sessionBox: WebSocketSessionBox(session: transport),
            onConnected: {
                guard let worker, let route = await gateway.currentRoute() else { return }
                #expect(await worker.setRoute(route, authorityGeneration: authorityGeneration))
                await worker.gatewayConnected(ifCurrentRoute: route)
            },
            onDisconnected: { _ in },
            onInvoke: { BridgeInvokeResponse(id: $0.id, ok: true) },
            onRouteInvalidated: {
                _ = await worker?.setRoute(nil, authorityGeneration: authorityGeneration)
            })
    }

    private func pairingPayload(requestId: String, decision: String = "approved") -> AnyCodable {
        AnyCodable([
            "requestId": AnyCodable(requestId), "nodeId": AnyCodable("test-node"),
            "decision": AnyCodable(decision), "ts": AnyCodable(1_800_000_000_000 as Int64),
        ])
    }

    private func eventData(
        event: String = "node.pair.resolved",
        requestId: String,
        decision: String = "approved") throws -> Data
    {
        try JSONEncoder().encode(EventFrame(
            type: "event", event: event,
            payload: self.pairingPayload(requestId: requestId, decision: decision),
            seq: nil, stateversion: nil))
    }

    private func emit(
        event: String = "node.pair.resolved",
        decision: String = "approved",
        requestId: String,
        socket: GatewayTestWebSocketTask) async throws
    {
        try await self.waitUntil("socket receive") { socket.hasPendingReceiveHandler() }
        try socket.emitReceiveSuccessOnce(.data(self.eventData(event: event, requestId: requestId, decision: decision)))
        try await self.waitUntil("socket event delivery") { socket.hasPendingReceiveHandler() }
    }

    private func frames(from worker: MacNodeHostWorker) async throws -> [WorkerGatewayFrame] {
        let response = try await AsyncTimeout.withTimeout(
            seconds: 5,
            onTimeout: { WorkerPipeTimeout(operation: "worker pipe inspection") },
            operation: { await worker.invoke(BridgeInvokeRequest(id: "inspect", command: "test.inspect")) })
        #expect(response.ok)
        let payload = try #require(response.payload)
        return try JSONDecoder().decode([WorkerGatewayFrame].self, from: JSONEncoder().encode(payload))
    }

    private func waitForEvents(_ count: Int, worker: MacNodeHostWorker) async throws -> [WorkerGatewayFrame] {
        try await self.waitUntil("\(count) forwarded pairing events") {
            try await self.frames(from: worker).filter { $0.type == "gateway-event" }.count >= count
        }
        return try await self.frames(from: worker).filter { $0.type == "gateway-event" }
    }

    private func waitUntil(
        _ operation: String,
        condition: @escaping @Sendable () async throws -> Bool) async throws
    {
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        while ContinuousClock.now < deadline {
            if try await condition() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        throw WorkerPipeTimeout(operation: operation)
    }
}
