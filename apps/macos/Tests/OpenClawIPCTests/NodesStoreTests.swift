import ConcurrencyExtras
import Foundation
import Observation
import OpenClawKit
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct NodesStoreTests {
    @Test func `named profile keeps durable node service unavailability informational`() async {
        let store = NodesStore(
            appProfile: AppProfile(environment: ["OPENCLAW_PROFILE": "work"]),
            localNodeIdentityProfile: .node,
            localNodeIDLoader: { _ in nil })

        #expect(store.persistentServiceNotice ==
            "Persistent Mac node service unavailable under app profile; runtime node remains available.")
        #expect(store.lastError == nil)
        await store.prepareLocalNodeIdentity()
        #expect(store.localNodeIdentityState == .unavailable)
        #expect(store.persistentServiceNotice != nil)
        #expect(store.lastError == nil)
    }

    @Test func `local node identity is prepared once`() async {
        let loader = LocalNodeIdentityLoader(results: ["node-id"])
        let store = NodesStore(
            localNodeIdentityProfile: .node,
            localNodeIDLoader: loader.load)

        async let first: Void = store.prepareLocalNodeIdentity()
        async let second: Void = store.prepareLocalNodeIdentity()
        _ = await (first, second)
        await store.prepareLocalNodeIdentity()

        #expect(store.localNodeIdentityState == .available("node-id"))
        #expect(loader.loadedProfiles == [.node])
    }

    @Test func `unavailable local node identity can be retried`() async {
        let loader = LocalNodeIdentityLoader(results: [nil, "node-id"])
        let store = NodesStore(
            localNodeIdentityProfile: .primary,
            localNodeIDLoader: loader.load)

        await store.prepareLocalNodeIdentity()
        #expect(store.localNodeIdentityState == .unavailable)

        await store.prepareLocalNodeIdentity()
        #expect(store.localNodeIdentityState == .available("node-id"))
        #expect(loader.loadedProfiles == [.primary, .primary])
    }
}

private final class LocalNodeIdentityLoader: @unchecked Sendable {
    private let lock = NSLock()
    private var results: [String?]
    private var profiles: [GatewayDeviceIdentityProfile] = []

    init(results: [String?]) {
        self.results = results
    }

    var loadedProfiles: [GatewayDeviceIdentityProfile] {
        self.lock.withLock { self.profiles }
    }

    func load(profile: GatewayDeviceIdentityProfile) -> String? {
        self.lock.withLock {
            self.profiles.append(profile)
            return self.results.isEmpty ? nil : self.results.removeFirst()
        }
    }
}

extension NodesStoreTests {
    @Test(arguments: [false, true])
    func `pending device lookup cannot reopen an explicitly disconnected Gateway`(disconnect: Bool) async throws {
        let gate = GatewayConnectionSuspensionGate()
        try await self.withFixture(endpointGate: gate) { fixture in
            fixture.holdNodes.setValue(false)
            let control = fixture.control
            let store = fixture.makeStore()
            store.start()
            await gate.waitUntilStarted()
            if disconnect { await control.disconnect() }
            await gate.open()
            try await fixture.waitUntil { !store.isLoading }
            if disconnect {
                #expect(fixture.session.snapshotMakeCount() == 0)
                #expect(fixture.requests.value.isEmpty)
                #expect(control.state == .disconnected)
                #expect(store.nodes.isEmpty)
                #expect(store.lastError == nil)
                // A newly requested refresh may connect after the retired lookup finishes.
                await store.refresh()
            }
            #expect(store.nodes.map(\.nodeId) == ["node-A"])
            #expect(!store.isLoading)
        }
    }

    @Test
    func `retiring a Gateway invalidates the observed device cache`() async throws {
        try await self.withFixture { fixture in
            fixture.holdNodes.setValue(false)
            let store = fixture.makeStore()
            store.start()
            do {
                try await fixture.waitUntil { store.nodes.first?.nodeId == "node-A" }
                let changed = LockIsolated(false)
                withObservationTracking {
                    _ = store.nodes
                } onChange: {
                    changed.setValue(true)
                }
                fixture.revision.setValue(2)
                await fixture.gateway.shutdown()
                try await fixture.waitUntil { changed.value }
                #expect(store.nodes.isEmpty)
            } catch {
                store.stop()
                await fixture.gateway.shutdown()
                throw error
            }
            store.stop()
        }
    }

    @Test(arguments: [false, true], [false, true])
    func `device replies and errors belong to the selected Gateway`(
        replaceGateway: Bool,
        failResponse: Bool) async throws
    {
        try await self.withFixture { fixture in
            let store = fixture.makeStore()
            let refresh = Task { await store.refresh() }
            do {
                let request = try await fixture.waitForNodeRequest()
                if replaceGateway { fixture.revision.setValue(2) }
                NodesGatewayFixture.respond(request, failure: failResponse)
                await refresh.value

                #expect(!store.isLoading)
                if replaceGateway {
                    #expect(store.nodes.isEmpty)
                    #expect(store.lastError == nil)
                } else if failResponse {
                    #expect(store.nodes.isEmpty)
                    #expect(store.lastError?.contains("Gateway A failure") == true)
                } else {
                    #expect(store.nodes.map(\.nodeId) == ["node-A"])
                    #expect(store.lastError == nil)
                }
            } catch {
                refresh.cancel()
                await fixture.gateway.shutdown()
                await refresh.value
                throw error
            }
            await fixture.gateway.shutdown()
        }
    }

    @Test(arguments: ["unchanged", "reconnect", "replacement"])
    func `cached devices remain visible only for their logical Gateway`(_ transition: String) async throws {
        try await self.withFixture { fixture in
            fixture.holdNodes.setValue(false)
            let store = fixture.makeStore()
            await store.refresh()
            #expect(store.nodes.map(\.nodeId) == ["node-A"])
            let lease = try #require(await fixture.gateway.captureServerLease())
            if transition == "replacement" {
                fixture.revision.setValue(2)
            } else if transition == "reconnect" {
                fixture.session.latestTask()?.emitReceiveFailure()
                try await fixture.waitUntil { !fixture.gateway.serverLeaseMatchesCurrentState(lease) }
                _ = try await fixture.gateway.acquireServerLease()
            }
            // AppKit projects the cached menu before starting its asynchronous refresh.
            #expect(store.nodes.map(\.nodeId) == (transition == "replacement" ? [] : ["node-A"]))
            await fixture.gateway.shutdown()
        }
    }

    @Test
    func `replacement device refresh owns loading and publication`() async throws {
        try await self.withFixture { fixture in
            let store = fixture.makeStore()
            let first = Task { await store.refresh() }
            var second: Task<Void, Never>?
            do {
                let a = try await fixture.waitForNodeRequest()
                fixture.revision.setValue(2)
                let replacement = Task { await store.refresh() }
                second = replacement
                let b = try await fixture.waitForNodeRequest(after: a.id)
                #expect(b.owner == "B")
                NodesGatewayFixture.respond(a)
                await first.value
                #expect(store.isLoading)
                #expect(store.nodes.isEmpty)
                NodesGatewayFixture.respond(b)
                await replacement.value
                #expect(!store.isLoading)
                #expect(store.nodes.map(\.nodeId) == ["node-B"])
            } catch {
                first.cancel()
                second?.cancel()
                await fixture.gateway.shutdown()
                await first.value
                await second?.value
                throw error
            }
            await fixture.gateway.shutdown()
        }
    }

    @Test(arguments: [false, true])
    func `closing and reopening device polling retires its pending read`(replaceGateway: Bool) async throws {
        try await self.withFixture { fixture in
            let store = fixture.makeStore()
            store.start()
            do {
                let first = try await fixture.waitForNodeRequest()
                store.stop()
                if replaceGateway { fixture.revision.setValue(2) }
                store.start()
                let second = try await fixture.waitForNodeRequest(after: first.id)
                NodesGatewayFixture.respond(first)
                #expect(store.isLoading)
                NodesGatewayFixture.respond(second)
                let expectedID = replaceGateway ? "node-B" : "node-A"
                try await fixture.waitUntil { store.nodes.first?.nodeId == expectedID }
                #expect(!store.isLoading)
                #expect(store.lastError == nil)
            } catch {
                store.stop()
                await fixture.gateway.shutdown()
                throw error
            }
            store.stop()
            await fixture.gateway.shutdown()
        }
    }

    @Test
    func `open device menu refreshes a replacement hello immediately`() async throws {
        try await self.withFixture { fixture in
            let store = fixture.makeStore()
            store.start()
            do {
                let first = try await fixture.waitForNodeRequest()
                NodesGatewayFixture.respond(first)
                try await fixture.waitUntil { store.nodes.first?.nodeId == "node-A" }
                fixture.revision.setValue(2)
                _ = try await fixture.gateway.acquireServerLease()
                let second = try await fixture.waitForNodeRequest(after: first.id)
                #expect(second.owner == "B")
                #expect(store.nodes.isEmpty)
                NodesGatewayFixture.respond(second)
                try await fixture.waitUntil { store.nodes.first?.nodeId == "node-B" }
                #expect(!store.isLoading)
            } catch {
                store.stop()
                await fixture.gateway.shutdown()
                throw error
            }
            store.stop()
            await fixture.gateway.shutdown()
        }
    }

    @Test(arguments: [false, true])
    func `device admission failure cannot publish after Gateway selection changes`(replaceGateway: Bool) async throws {
        let gate = AsyncTestGate()
        try await self.withFixture(failingEndpointGate: gate) { fixture in
            let store = fixture.makeStore()
            let refresh = Task { await store.refresh() }
            do {
                try await fixture.waitUntil { fixture.endpointEntered.value }
                if replaceGateway { fixture.revision.setValue(2) }
                gate.open()
                await refresh.value
                #expect(!store.isLoading)
                #expect(store.nodes.isEmpty)
                #expect((store.lastError != nil) == !replaceGateway)
                #expect(fixture.session.snapshotMakeCount() == 0)
            } catch {
                gate.open()
                refresh.cancel()
                await refresh.value
                await fixture.gateway.shutdown()
                throw error
            }
            await fixture.gateway.shutdown()
        }
    }

    private func withFixture(
        failingEndpointGate: AsyncTestGate? = nil,
        endpointGate: GatewayConnectionSuspensionGate? = nil,
        _ operation: (NodesGatewayFixture) async throws -> Void) async throws
    {
        try await TestIsolation.withIsolatedState {
            let state = AppStateStore.shared
            let previousMode = state.connectionMode
            let previousAccent = state.profileAccentHex
            let previousMainKey = WorkActivityStore.shared.mainSessionKey
            // The synthetic transport owns no local process; recovery fixtures own that handoff.
            state.connectionMode = .unconfigured
            defer {
                state.connectionMode = previousMode
                state.profileAccentHex = previousAccent
                WorkActivityStore.shared.reset()
                WorkActivityStore.shared.setMainSessionKey(previousMainKey)
            }
            let fixture = NodesGatewayFixture(failingEndpointGate: failingEndpointGate, endpointGate: endpointGate)
            do {
                try await operation(fixture)
                await fixture.stop()
            } catch {
                await fixture.stop()
                throw error
            }
        }
    }
}

@MainActor
private final class NodesGatewayFixture {
    struct Request: Sendable {
        let owner: String
        let id: String
        let method: String
        let socket: GatewayTestWebSocketTask
    }

    let revision = LockIsolated<UInt64>(1)
    let requests = LockIsolated<[Request]>([])
    let holdNodes = LockIsolated(true)
    let endpointEntered = LockIsolated(false)
    let session: GatewayTestWebSocketSession
    let gateway: GatewayConnection
    let control: ControlChannel
    private var store: NodesStore?

    init(failingEndpointGate: AsyncTestGate? = nil, endpointGate: GatewayConnectionSuspensionGate? = nil) {
        let revision = self.revision
        let requests = self.requests
        let holdNodes = self.holdNodes
        let endpointEntered = self.endpointEntered
        self.session = GatewayTestWebSocketSession(taskFactory: {
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
                let request = Request(owner: owner, id: id, method: method, socket: socket)
                requests.withValue { $0.append(request) }
                if method != "node.list" || !holdNodes.value { Self.respond(request) }
            })
        })
        self.gateway = GatewayConnection(
            testEndpointProvider: {
                await endpointGate?.suspend()
                let current = revision.value
                if let failingEndpointGate {
                    endpointEntered.setValue(true)
                    await failingEndpointGate.wait()
                    throw URLError(.cannotConnectToHost)
                }
                return GatewayConnection.EndpointSnapshot(
                    config: (URL(string: "ws://127.0.0.1:\(49600 + current)")!, nil, nil),
                    routeAuthority: nil,
                    revision: current)
            },
            currentEndpointRevision: { revision.value },
            sessionBox: WebSocketSessionBox(session: self.session))
        self.control = ControlChannel(gateway: self.gateway, endpointRevision: { revision.value })
    }

    @MainActor
    func makeStore() -> NodesStore {
        let store = NodesStore(control: self.control, localNodeIDLoader: { _ in "synthetic-local-node" })
        self.store = store
        return store
    }

    func stop() async {
        self.store?.stop()
        await self.control.disconnect()
    }

    @MainActor
    func waitUntil(_ condition: () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(2)
        while !condition(), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(2))
        }
        try #require(condition())
    }

    @MainActor
    func waitForNodeRequest(after previousID: String? = nil) async throws -> Request {
        try await self.waitUntil {
            self.requests.value.last(where: { $0.method == "node.list" })?.id != previousID
        }
        return try #require(self.requests.value.last(where: { $0.method == "node.list" }))
    }

    nonisolated static func respond(_ request: Request, failure: Bool = false) {
        let json: String
        if failure {
            json = #"""
            {"type":"res","id":"\#(request.id)","ok":false,
            "error":{"code":"INVALID_REQUEST","message":"Gateway \#(request.owner) failure"}}
            """#
        } else {
            let payload = request.method == "node.list"
                ? #"""
                {"ts":1800000000000,"nodes":[{"nodeId":"node-\#(request.owner)",
                "displayName":"Gateway \#(request.owner) device","paired":true,"connected":true}]}
                """#
                : #"{"ok":true}"#
            json = #"{"type":"res","id":"\#(request.id)","ok":true,"payload":\#(payload)}"#
        }
        request.socket.emitReceiveSuccess(.data(Data(json.utf8)))
    }
}
