import ConcurrencyExtras
import Foundation
import Testing
@testable import OpenClaw
@testable import OpenClawKit

@MainActor
private final class HealthGatewayFixture {
    struct Request: Sendable {
        let owner: String
        let id: String
        let method: String
        let isPreflight: Bool
        let socket: GatewayTestWebSocketTask
    }

    let revision = LockIsolated<UInt64>(1)
    let requests = LockIsolated<[Request]>([])
    let held = LockIsolated<Request?>(nil)
    let onHeldRequest = LockIsolated<(@Sendable (Request) -> Void)?>(nil)
    let holdHealth = LockIsolated(false)
    let holdPreflight = LockIsolated(true)
    let gateway: GatewayConnection
    let control: ControlChannel
    private let previousAccent = AppStateStore.shared.profileAccentHex
    private let previousMainKey = WorkActivityStore.shared.mainSessionKey
    private let previousMode = AppStateStore.shared.connectionMode

    init(endpointGate: GatewayConnectionSuspensionGate? = nil) {
        // The synthetic transport owns no local process; dedicated recovery tests own that handoff.
        AppStateStore.shared.connectionMode = .unconfigured
        let revision = self.revision
        let requests = self.requests
        let held = self.held
        let onHeldRequest = self.onHeldRequest
        let holdHealth = self.holdHealth
        let holdPreflight = self.holdPreflight
        let session = GatewayTestWebSocketSession(taskFactory: {
            let owner = revision.value == 1 ? "A" : "B"
            return GatewayTestWebSocketTask(sendHook: { socket, message, sendIndex in
                guard sendIndex > 0 else { return }
                let data: Data
                switch message {
                case let .data(value): data = value
                case let .string(value): data = Data(value.utf8)
                @unknown default: return
                }
                guard let frame = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let id = frame["id"] as? String,
                      let method = frame["method"] as? String else { return }
                let isPreflight = method == "health" && (frame["params"] as? [String: Any])?["timeout"] == nil
                let request = Request(owner: owner, id: id, method: method, isPreflight: isPreflight, socket: socket)
                requests.withValue { $0.append(request) }
                if request.method == "health", holdHealth.value,
                   !isPreflight || holdPreflight.value
                {
                    if let onHeldRequest = onHeldRequest.value {
                        onHeldRequest(request)
                    } else {
                        held.setValue(request)
                    }
                } else {
                    Self.respond(request)
                }
            })
        })
        self.gateway = GatewayConnection(
            testEndpointProvider: {
                await endpointGate?.suspend()
                let current = revision.value
                return GatewayConnection.EndpointSnapshot(
                    config: (URL(string: "ws://127.0.0.1:\(49400 + current)")!, nil, nil),
                    routeAuthority: nil,
                    revision: current)
            },
            currentEndpointRevision: { revision.value },
            sessionBox: WebSocketSessionBox(session: session))
        self.control = ControlChannel(gateway: self.gateway, endpointRevision: { revision.value })
    }

    func connectAndHoldHealth() async throws {
        do {
            _ = try await self.gateway.acquireServerLease()
            self.holdHealth.setValue(true)
        } catch {
            await self.stop()
            throw error
        }
    }

    func stop() async {
        await self.control.disconnect()
        AppStateStore.shared.connectionMode = self.previousMode
        WorkActivityStore.shared.reset()
        WorkActivityStore.shared.setMainSessionKey(self.previousMainKey)
        AppStateStore.shared.profileAccentHex = self.previousAccent
    }

    func waitForHeld(after previousID: String? = nil) async throws -> Request {
        let deadline = ContinuousClock.now + .seconds(2)
        while self.held.value == nil || self.held.value?.id == previousID, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(2))
        }
        let request = try #require(self.held.value)
        try #require(request.id != previousID)
        return request
    }

    nonisolated static func respond(_ request: Request, failure: Bool = false) {
        let json: String
        if failure {
            json = #"""
            {"type":"res","id":"\#(request.id)","ok":false,
             "error":{"code":"INVALID_REQUEST","message":"synthetic health failure"}}
            """#
        } else {
            let payload = #"""
            {"ok":true,"ts":1800000000000,"durationMs":1,
             "channels":{"fixture":{"linked":true}},"channelOrder":["fixture"],
             "channelLabels":{"fixture":"Gateway \#(request.owner)"},
             "sessions":{"path":"/synthetic","count":0,"recent":[]}}
            """#
            json = #"{"type":"res","id":"\#(request.id)","ok":true,"payload":\#(payload)}"#
        }
        request.socket.emitReceiveSuccess(.data(Data(json.utf8)))
    }
}

@Suite(.serialized)
@MainActor
struct GatewayHealthOwnershipTests {
    @Test(arguments: [false, true], [false, true])
    func `health replies cannot replace another Gateways state`(
        replaceGateway: Bool,
        failHealth: Bool) async throws
    {
        try await TestIsolation.withIsolatedState {
            let fixture = HealthGatewayFixture()
            try await fixture.connectAndHoldHealth()
            let store = HealthStore(control: fixture.control)
            fixture.onHeldRequest.setValue { [revision = fixture.revision] request in
                if replaceGateway { revision.setValue(2) }
                HealthGatewayFixture.respond(request, failure: failHealth)
            }
            await store.refresh(onDemand: true)
            let result = (
                snapshot: store.snapshot, lastError: store.lastError,
                isRefreshing: store.isRefreshing, lastPingMs: fixture.control.lastPingMs)
            let requests = fixture.requests.value
            await fixture.stop()

            try #require(requests.contains { $0.method == "health" && !$0.isPreflight })
            #expect(!result.isRefreshing)
            if replaceGateway {
                #expect(result.snapshot == nil)
                #expect(result.lastError == nil)
            } else if failHealth {
                #expect(result.lastError != nil)
                #expect(result.snapshot == nil)
            } else {
                #expect(result.snapshot?.channelLabels?["fixture"] == "Gateway A")
                #expect(result.lastError == nil)
                #expect(result.lastPingMs != nil)
            }
        }
    }

    @Test
    func `replacement health refresh owns loading and publication`() async throws {
        try await TestIsolation.withIsolatedState {
            let fixture = HealthGatewayFixture()
            try await fixture.connectAndHoldHealth()
            let store = HealthStore(control: fixture.control)
            let first = Task { await store.refresh() }
            var second: Task<Void, Never>?
            do {
                let a = try await fixture.waitForHeld()
                fixture.revision.setValue(2)
                let bRefresh = Task { await store.refresh() }
                second = bRefresh
                let bBootstrap = try await fixture.waitForHeld(after: a.id)
                HealthGatewayFixture.respond(bBootstrap)
                let b = try await fixture.waitForHeld(after: bBootstrap.id)
                HealthGatewayFixture.respond(a)
                await first.value
                #expect(store.isRefreshing)
                #expect(store.snapshot == nil)
                HealthGatewayFixture.respond(b)
                await bRefresh.value
                #expect(!store.isRefreshing)
                #expect(store.snapshot?.channelLabels?["fixture"] == "Gateway B")
            } catch {
                first.cancel()
                second?.cancel()
                await fixture.stop()
                await first.value
                await second?.value
                throw error
            }
            await fixture.stop()
        }
    }

    @Test
    func `same-route reconnect retains last-good health while refreshing`() async throws {
        try await TestIsolation.withIsolatedState {
            let fixture = HealthGatewayFixture()
            let store = HealthStore(control: fixture.control)
            var refresh: Task<Void, Never>?
            do {
                await store.refresh()
                let lease = try #require(await fixture.gateway.captureServerLease())
                let socket = try #require(fixture.requests.value.last?.socket)
                socket.emitReceiveFailure()
                let deadline = ContinuousClock.now + .seconds(2)
                while fixture.gateway.serverLeaseMatchesCurrentState(lease), ContinuousClock.now < deadline {
                    try await Task.sleep(for: .milliseconds(2))
                }
                #expect(!fixture.gateway.serverLeaseMatchesCurrentState(lease))
                fixture.holdHealth.setValue(true)
                let pendingRefresh = Task { await store.refresh() }
                refresh = pendingRefresh
                let first = try await fixture.waitForHeld()
                #expect(store.snapshot?.channelLabels?["fixture"] == "Gateway A")
                let read: HealthGatewayFixture.Request
                if first.isPreflight {
                    HealthGatewayFixture.respond(first)
                    read = try await fixture.waitForHeld(after: first.id)
                } else {
                    read = first
                }
                HealthGatewayFixture.respond(read, failure: true)
                await pendingRefresh.value
                #expect(store.snapshot?.channelLabels?["fixture"] == "Gateway A")
                #expect(store.lastError != nil)
                fixture.revision.setValue(2)
                #expect(store.snapshot == nil)
                #expect(store.lastError == nil)
            } catch {
                refresh?.cancel()
                await fixture.stop()
                await refresh?.value
                throw error
            }
            await fixture.stop()
        }
    }

    @Test
    func `health subscription refreshes replacement hello without losing bootstrap`() async throws {
        try await TestIsolation.withIsolatedState {
            let fixture = HealthGatewayFixture()
            fixture.holdPreflight.setValue(false)
            fixture.holdHealth.setValue(true)
            let store = HealthStore(control: fixture.control)
            store.start()
            do {
                let a = try await fixture.waitForHeld()
                HealthGatewayFixture.respond(a)
                let firstDeadline = ContinuousClock.now + .seconds(2)
                while store.snapshot == nil, ContinuousClock.now < firstDeadline {
                    try await Task.sleep(for: .milliseconds(2))
                }
                #expect(store.snapshot?.channelLabels?["fixture"] == "Gateway A")
                a.socket.emitReceiveFailure()
                let disconnectDeadline = ContinuousClock.now + .seconds(2)
                while store.lastError == nil, ContinuousClock.now < disconnectDeadline {
                    try await Task.sleep(for: .milliseconds(2))
                }
                #expect(store.lastError != nil)
                #expect(store.snapshot?.channelLabels?["fixture"] == "Gateway A")
                fixture.revision.setValue(2)
                #expect(store.lastError == nil)
                _ = try await fixture.gateway.acquireServerLease()
                let b = try await fixture.waitForHeld(after: a.id)
                #expect(store.snapshot == nil)
                HealthGatewayFixture.respond(b)
                let secondDeadline = ContinuousClock.now + .seconds(2)
                while store.snapshot == nil, ContinuousClock.now < secondDeadline {
                    try await Task.sleep(for: .milliseconds(2))
                }
                #expect(store.snapshot?.channelLabels?["fixture"] == "Gateway B")
                #expect(!store.isRefreshing)
            } catch {
                await fixture.stop()
                throw error
            }
            await fixture.stop()
        }
    }

    @Test(arguments: [false, true])
    func `health transport failure preserves cache only for background reads`(onDemand: Bool) async throws {
        try await TestIsolation.withIsolatedState {
            let fixture = HealthGatewayFixture()
            fixture.holdPreflight.setValue(false)
            fixture.holdHealth.setValue(true)
            let store = HealthStore(control: fixture.control)
            store.start()
            var refresh: Task<Void, Never>?
            do {
                let initial = try await fixture.waitForHeld()
                HealthGatewayFixture.respond(initial)
                let deadline = ContinuousClock.now + .seconds(2)
                while store.isRefreshing || store.snapshot == nil, ContinuousClock.now < deadline {
                    try await Task.sleep(for: .milliseconds(2))
                }
                try #require(store.snapshot?.channelLabels?["fixture"] == "Gateway A")
                try #require(!store.isRefreshing)
                let read = Task { await store.refresh(onDemand: onDemand) }
                refresh = read
                let pending = try await fixture.waitForHeld(after: initial.id)
                pending.socket.emitReceiveFailure()
                await read.value
                let disconnectDeadline = ContinuousClock.now + .seconds(2)
                while store.lastError == nil, ContinuousClock.now < disconnectDeadline {
                    try await Task.sleep(for: .milliseconds(2))
                }
                #expect(store.lastError != nil)
                #expect(!store.isRefreshing)
                #expect(store.snapshot?.channelLabels?["fixture"] == (onDemand ? nil : "Gateway A"))
            } catch {
                refresh?.cancel()
                await fixture.stop()
                await refresh?.value
                throw error
            }
            await fixture.stop()
        }
    }

    @Test
    func `pending health read cannot reopen an explicitly disconnected Gateway`() async {
        await TestIsolation.withIsolatedState {
            let gate = GatewayConnectionSuspensionGate()
            let fixture = HealthGatewayFixture(endpointGate: gate)
            let store = HealthStore(control: fixture.control)
            let refresh = Task { await store.refresh() }
            await gate.waitUntilStarted()
            await fixture.control.disconnect()
            await gate.open()
            await refresh.value

            #expect(fixture.requests.value.isEmpty)
            #expect(fixture.control.state == .disconnected)
            #expect(store.snapshot == nil)
            // A new operator request after disconnect remains allowed to connect.
            await store.refresh()
            #expect(store.snapshot?.channelLabels?["fixture"] == "Gateway A")
            #expect(fixture.control.state == .connected)
            await fixture.stop()
        }
    }
}

extension GatewayConnectionControlTests {
    @Test(arguments: [false, true]) @MainActor
    func `connection refresh keeps auth-source labels with their admitted Gateway`(replaceGateway: Bool) async throws {
        try await TestIsolation.withIsolatedState {
            let fixture = HealthGatewayFixture()
            fixture.holdHealth.setValue(true)
            let refresh = Task { await fixture.control.refreshEndpoint(reason: "source ownership proof") }
            do {
                let a = try await fixture.waitForHeld()
                if replaceGateway { fixture.revision.setValue(2) }
                HealthGatewayFixture.respond(a)
                await refresh.value
                #expect(fixture.control.authSourceLabel == (replaceGateway ? nil : "Auth: none"))
            } catch {
                refresh.cancel()
                await fixture.stop()
                await refresh.value
                throw error
            }
            await fixture.stop()
        }
    }
}
