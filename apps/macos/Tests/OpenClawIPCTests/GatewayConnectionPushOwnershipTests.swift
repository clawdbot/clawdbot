import ConcurrencyExtras
import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClaw
@testable import OpenClawKit

extension GatewayConnectionControlTests {
    @Test(arguments: ["unavailable", "adopted", "admitted", "reconnect", "shutdown", "replaced-shutdown"]) @MainActor
    func `buffered primary pushes cannot restore retired work or reset a current handshake`(
        replacement: String) async throws
    {
        try await TestIsolation.withIsolatedState {
            let previousMode = AppStateStore.shared.connectionMode
            // This synthetic transport owns no local process. Recovery's process
            // handoff is exercised by the dedicated local/remote recovery fixtures.
            AppStateStore.shared.connectionMode = .unconfigured
            defer { AppStateStore.shared.connectionMode = previousMode }
            let source = GatewayConnectionEndpointSource(endpoint: GatewayConnection.EndpointSnapshot(
                config: (URL(string: "ws://127.0.0.1:49225")!, nil, nil), routeAuthority: nil, revision: 1))
            let mainKey = LockIsolated("a-main")
            let rejectConnect = LockIsolated(false)
            let session = GatewayTestWebSocketSession(taskFactory: {
                GatewayTestWebSocketTask(sendHook: { socket, message, sendIndex in
                    guard sendIndex > 0, let id = GatewayWebSocketTestSupport.requestID(from: message) else { return }
                    socket.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
                }, receiveHook: { socket, receiveIndex in
                    if receiveIndex == 0 { return .data(GatewayWebSocketTestSupport.connectChallengeData()) }
                    if rejectConnect.value { throw URLError(.cannotConnectToHost) }
                    return .data(GatewayWebSocketTestSupport.connectOkData(
                        id: socket.snapshotConnectRequestID() ?? "connect", mainSessionKey: mainKey.value))
                })
            })
            let connection = GatewayConnection(
                testEndpointProvider: { source.snapshot() },
                currentEndpointRevision: { source.snapshot().revision! },
                sessionBox: WebSocketSessionBox(session: session))
            let control = ControlChannel(gateway: connection, endpointRevision: { source.snapshot().revision! })
            let activity = WorkActivityStore.shared
            let previousKey = activity.mainSessionKey
            let previousAccent = AppStateStore.shared.profileAccentHex
            AppStateStore.shared.profileAccentHex = "#123456"
            defer {
                activity.reset()
                activity.setMainSessionKey(previousKey)
                AppStateStore.shared.profileAccentHex = previousAccent
            }
            _ = try await connection.request(method: "health", params: nil, retryTransportFailures: false)
            #expect(await self.waitForMainSessionKey("a-main"))
            let initialDeadline = ContinuousClock.now + .seconds(2)
            while AppStateStore.shared.profileAccentHex != nil, ContinuousClock.now < initialDeadline {
                try await Task.sleep(for: .milliseconds(10))
            }
            #expect(AppStateStore.shared.profileAccentHex == nil)

            let acknowledgement = UUID().uuidString
            let buffered = await connection.subscribe()
            // Leave this real subscription unread while its owner advances. The
            // live Control consumer stays free to process work on the MainActor.
            let producer = Task.detached {
                if replacement.contains("shutdown") {
                    await connection._test_handlePush(
                        .event(EventFrame(type: "event", event: "shutdown")), socketGeneration: 1)
                } else {
                    await connection._test_handlePush(
                        .snapshot(makeGatewayGenerationSnapshot(version: "gateway-a", mainSessionKey: "a-main")),
                        socketGeneration: 1)
                    await connection._test_handlePush(Self.workStarted(sessionKey: "a-main"), socketGeneration: 1)
                }
                mainKey.withValue { $0 = "b-main" }
                rejectConnect.withValue {
                    $0 = replacement == "unavailable" || replacement == "adopted" || replacement == "shutdown"
                }
                if replacement == "reconnect" || replacement == "shutdown" {
                    session.latestTask()?.emitReceiveFailure()
                    let deadline = ContinuousClock.now + .seconds(2)
                    while await connection._test_activeSocketGeneration() != nil, ContinuousClock.now < deadline {
                        try await Task.sleep(for: .milliseconds(10))
                    }
                } else {
                    if replacement != "shutdown" {
                        source.setEndpoint(GatewayConnection.EndpointSnapshot(
                            config: (URL(string: "ws://127.0.0.1:49226")!, nil, nil), routeAuthority: nil, revision: 2))
                        await control.endpointDidChange(.connecting(
                            mode: .remote, detail: "Switching Gateway", routeRevision: 2))
                    }
                    if replacement != "adopted" { await connection.shutdown() }
                }
                let socket: UInt64 = replacement == "reconnect" ? 2 : 1
                if replacement == "admitted" || replacement == "reconnect" || replacement == "replaced-shutdown" {
                    _ = try await connection.request(method: "health", params: nil, retryTransportFailures: false)
                    let hello = makeGatewayGenerationSnapshot(version: "gateway-b", mainSessionKey: "b-main")
                    await connection._test_handlePush(.snapshot(hello), socketGeneration: socket)
                    await connection._test_handlePush(Self.workStarted(sessionKey: "b-main"), socketGeneration: socket)
                    await connection._test_handlePush(.snapshot(hello), socketGeneration: socket)
                    await connection._test_handlePush(
                        .event(EventFrame(
                            type: "event",
                            event: "heartbeat",
                            payload: OpenClawProtocol.AnyCodable(["ts": 1, "status": acknowledgement]))),
                        socketGeneration: socket)
                }
            }
            do {
                try await producer.value
                try await Self.assertBufferedOwnership(buffered, replacement: replacement)
            } catch {
                await control.disconnect()
                throw error
            }
            let deadline = ContinuousClock.now + .seconds(2)
            while control.lastHeartbeatEvent?.status != acknowledgement,
                  !(["unavailable", "adopted"].contains(replacement) && activity.current?.sessionKey == "a-main"),
                  ContinuousClock.now < deadline
            {
                try await Task.sleep(for: .milliseconds(10))
            }
            if replacement == "shutdown" {
                guard case .degraded = control.state else {
                    Issue.record("current Gateway shutdown must remain visible")
                    await control.disconnect()
                    return
                }
            } else if replacement == "unavailable" || replacement == "adopted" {
                #expect(activity.mainSessionKey == "a-main")
                #expect(activity.current == nil)
            } else {
                #expect(control.lastHeartbeatEvent?.status == acknowledgement)
                #expect(activity.mainSessionKey == "b-main")
                #expect(activity.current?.sessionKey == "b-main")
                #expect(activity.iconState == .workingMain(.job))
                #expect(control.state == .connected)
            }
            await control.disconnect()
        }
    }

    private nonisolated static func assertBufferedOwnership(
        _ stream: AsyncStream<GatewayConnection.PushDelivery>,
        replacement: String) async throws
    {
        let admitsReplacement = ["admitted", "reconnect", "replaced-shutdown"].contains(replacement)
        let terminalEvent = admitsReplacement ? "heartbeat" : (replacement == "shutdown" ? "shutdown" : "agent")
        let deliveries = try await AsyncTimeout.withTimeout(
            seconds: 2,
            onTimeout: { CancellationError() },
            operation: {
                var queued: [GatewayConnection.PushDelivery] = []
                for await delivery in stream {
                    queued.append(delivery)
                    if case let .event(event) = delivery.push, event.event == terminalEvent { break }
                }
                return queued
            })
        let oldDeliveries = deliveries.filter { $0.mainSessionKey == "a-main" }
        #expect(oldDeliveries.contains {
            if case .snapshot = $0.push {
                true
            } else {
                false
            }
        })
        #expect(oldDeliveries.contains {
            guard case let .event(event) = $0.push else { return false }
            return event.event == (replacement.contains("shutdown") ? "shutdown" : "agent")
        })
        for delivery in oldDeliveries {
            #expect(!delivery.isCurrent)
        }
        if admitsReplacement {
            let currentDeliveries = deliveries.filter { $0.mainSessionKey == "b-main" }
            #expect(!currentDeliveries.isEmpty)
            for delivery in currentDeliveries {
                #expect(delivery.isCurrent)
            }
        }
    }

    private nonisolated static func workStarted(sessionKey: String) -> GatewayPush {
        .event(EventFrame(
            type: "event",
            event: "agent",
            payload: OpenClawProtocol.AnyCodable([
                "runId": "buffered-work", "seq": 1, "stream": "job", "ts": 1,
                "data": ["sessionKey": sessionKey, "state": "started"],
            ])))
    }

    @Test(arguments: [false, true]) @MainActor
    func `an admitted profile accent response cannot publish after Primary changes`(failResponse: Bool) async throws {
        try await TestIsolation.withIsolatedState {
            let source = GatewayConnectionEndpointSource(endpoint: GatewayConnection.EndpointSnapshot(
                config: (URL(string: "ws://127.0.0.1:49227")!, nil, nil), routeAuthority: nil, revision: 1))
            let gate = GatewayConnectionSuspensionGate()
            let deferAccent = LockIsolated(false)
            let replied = LockIsolated(false)
            let session = GatewayTestWebSocketSession(taskFactory: {
                GatewayTestWebSocketTask(sendHook: { socket, message, sendIndex in
                    guard sendIndex > 0, let id = GatewayWebSocketTestSupport.requestID(from: message),
                          let data = Self.messageData(message),
                          let frame = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
                    else { return }
                    if frame["method"] as? String == "users.prefs.get", deferAccent.value {
                        await gate.suspend()
                        defer { replied.withValue { $0 = true } }
                        if failResponse { throw URLError(.networkConnectionLost) }
                        socket.emitReceiveSuccess(.data(Data("""
                        {"type":"res","id":"\(id)","ok":true,
                        "payload":{"status":"ok","entries":{"ui.accent":"#aa0000"}}}
                        """.utf8)))
                    } else {
                        socket.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
                    }
                })
            })
            let connection = GatewayConnection(
                testEndpointProvider: { source.snapshot() },
                currentEndpointRevision: { source.snapshot().revision! },
                sessionBox: WebSocketSessionBox(session: session))
            let control = ControlChannel(gateway: connection, endpointRevision: { source.snapshot().revision! })
            let state = AppStateStore.shared
            let previousAccent = state.profileAccentHex
            defer { state.profileAccentHex = previousAccent }
            state.profileAccentHex = "#123456"
            _ = try await connection.request(method: "health", params: nil, retryTransportFailures: false)
            let initialDeadline = ContinuousClock.now + .seconds(2)
            while state.profileAccentHex != nil, ContinuousClock.now < initialDeadline {
                try await Task.sleep(for: .milliseconds(10))
            }
            #expect(state.profileAccentHex == nil)

            deferAccent.withValue { $0 = true }
            await connection._test_handlePush(
                .event(EventFrame(type: "event", event: "users.prefs.changed")), socketGeneration: 1)
            await gate.waitUntilStarted()
            source.setEndpoint(GatewayConnection.EndpointSnapshot(
                config: (URL(string: "ws://127.0.0.1:49228")!, nil, nil), routeAuthority: nil, revision: 2))
            state.profileAccentHex = "#0000bb"
            await gate.open()
            let deadline = ContinuousClock.now + .seconds(2)
            while state.profileAccentHex == "#0000bb", ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(10))
            }
            #expect(replied.value)
            #expect(state.profileAccentHex == "#0000bb")
            await control.disconnect()
        }
    }
}
