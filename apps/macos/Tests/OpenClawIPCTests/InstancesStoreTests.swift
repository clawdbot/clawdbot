import AppKit
import ApplicationServices
import ConcurrencyExtras
import Foundation
import OpenClawProtocol
import SwiftUI
import Testing
@testable import OpenClaw
@testable import OpenClawKit

@Suite(.serialized)
@MainActor
struct InstancesStoreTests {
    @Test
    @MainActor
    func `presence event payload decodes via JSON encoder`() {
        // Build a payload that mirrors the gateway's presence event shape:
        // { "presence": [ PresenceEntry ] }
        let entry: [String: OpenClawProtocol.AnyCodable] = [
            "host": .init("gw"),
            "ip": .init("10.0.0.1"),
            "version": .init("2.0.0"),
            "mode": .init("gateway"),
            "lastInputSeconds": .init(5),
            "reason": .init("test"),
            "text": .init("Gateway node"),
            "ts": .init(1_730_000_000),
        ]
        let payloadMap: [String: OpenClawProtocol.AnyCodable] = [
            "presence": .init([OpenClawProtocol.AnyCodable(entry)]),
        ]
        let payload = OpenClawProtocol.AnyCodable(payloadMap)

        let store = InstancesStore(isPreview: true)
        store.handlePresenceEventPayload(payload)

        #expect(store.instances.count == 1)
        let instance = store.instances.first
        #expect(instance?.host == "gw")
        #expect(instance?.ip == "10.0.0.1")
        #expect(instance?.mode == "gateway")
        #expect(instance?.reason == "test")
    }

    @Test(arguments: [false, true], [false, true])
    func `presence replies and recovery stay with their originating Gateway`(
        replaceGateway: Bool,
        failPresence: Bool) async throws
    {
        try await TestIsolation.withIsolatedState {
            let fixture = InstancesGatewayFixture()
            let store = InstancesStore(control: fixture.control)
            let refresh = Task { await store.refresh() }
            func cleanup() async {
                refresh.cancel()
                await fixture.stop()
                await refresh.value
            }
            do {
                let deadline = ContinuousClock.now + .seconds(2)
                while fixture.held.value == nil, ContinuousClock.now < deadline {
                    try await Task.sleep(for: .milliseconds(2))
                }
                let held = try #require(fixture.held.value)
                let beforeReply = fixture.requests.value.count
                if replaceGateway { fixture.revision.setValue(2) }
                InstancesGatewayFixture.respond(held, failure: failPresence)
                await refresh.value

                #expect(!store.isLoading)
                if replaceGateway {
                    #expect(store.instances.isEmpty)
                    #expect(store.statusMessage == nil)
                    #expect(!fixture.requests.value.dropFirst(beforeReply).contains {
                        $0.owner == "B" && $0.method == "health"
                    })
                } else if failPresence {
                    #expect(store.instances.contains { $0.text.contains("Gateway A linked=true") })
                    #expect(store.statusMessage?.contains("local fallback") == true)
                } else {
                    #expect(store.instances.map(\.host) == ["Gateway A"])
                    #expect(store.statusMessage == nil)
                }
            } catch {
                await cleanup()
                throw error
            }
            await cleanup()
        }
    }

    @Test
    func `presence push supersedes an older list response`() async throws {
        try await TestIsolation.withIsolatedState {
            let fixture = InstancesGatewayFixture()
            let store = InstancesStore(control: fixture.control)
            let refresh = Task { await store.refresh() }
            do {
                let held = try await fixture.waitForHeld()
                store.handlePresenceEventPayload(.init([
                    "presence": [["host": "new presence", "ts": 1_800_000_000_001]],
                ]))
                InstancesGatewayFixture.respond(held)
                await refresh.value
                #expect(store.instances.map(\.host) == ["new presence"])
                #expect(!store.isLoading)
            } catch {
                refresh.cancel()
                await fixture.stop()
                await refresh.value
                throw error
            }
            await fixture.stop()
        }
    }

    @Test(arguments: [false, true], [false, true])
    func `pending reads cannot reopen an explicitly disconnected Gateway`(
        health: Bool,
        disconnect: Bool) async throws
    {
        try await TestIsolation.withIsolatedState {
            let gate = GatewayConnectionSuspensionGate()
            let fixture = InstancesGatewayFixture(holding: "", endpointGate: gate)
            let healthStore = HealthStore(control: fixture.control)
            let instancesStore = InstancesStore(control: fixture.control)
            let refresh = Task {
                if health {
                    await healthStore.refresh()
                } else {
                    await instancesStore.refresh()
                }
            }
            await gate.waitUntilStarted()
            if disconnect { await fixture.control.disconnect() }
            await gate.open()
            await refresh.value

            if disconnect {
                #expect(fixture.requests.value.isEmpty)
                #expect(fixture.control.state == .disconnected)
                #expect(healthStore.snapshot == nil)
                #expect(instancesStore.instances.isEmpty)
                // A new operator request after disconnect remains allowed to connect.
                if health { await healthStore.refresh() } else { await instancesStore.refresh() }
            }
            if health {
                #expect(healthStore.snapshot?.channelLabels?["fixture"] == "Gateway A")
            } else {
                #expect(instancesStore.instances.map(\.host) == ["Gateway A"])
            }
            #expect(fixture.control.state == .connected)
            await fixture.stop()
        }
    }

    @Test
    func `replacement presence refresh owns loading and publication`() async throws {
        try await TestIsolation.withIsolatedState {
            let fixture = InstancesGatewayFixture()
            let store = InstancesStore(control: fixture.control)
            let first = Task { await store.refresh() }
            var second: Task<Void, Never>?
            do {
                let a = try await fixture.waitForHeld()
                fixture.revision.setValue(2)
                let bRefresh = Task { await store.refresh() }
                second = bRefresh
                let b = try await fixture.waitForHeld(after: a.id)
                InstancesGatewayFixture.respond(a)
                await first.value
                #expect(store.isLoading)
                #expect(store.instances.isEmpty)
                InstancesGatewayFixture.respond(b)
                await bRefresh.value
                #expect(!store.isLoading)
                #expect(store.instances.map(\.host) == ["Gateway B"])
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

    @Test(arguments: [false, true])
    func `visible presence lifetime retires its pending read before reopening`(replaceGateway: Bool) async throws {
        try await TestIsolation.withIsolatedState {
            let fixture = InstancesGatewayFixture()
            let store = InstancesStore(control: fixture.control)
            store.start()
            do {
                let a = try await fixture.waitForHeld()
                store.stop()
                if replaceGateway { fixture.revision.setValue(2) }
                store.start()
                let b = try await fixture.waitForHeld(after: a.id)
                InstancesGatewayFixture.respond(a)
                #expect(store.isLoading)
                InstancesGatewayFixture.respond(b)
                let expected = replaceGateway ? "Gateway B" : "Gateway A"
                let deadline = ContinuousClock.now + .seconds(2)
                while store.instances.first?.host != expected, ContinuousClock.now < deadline {
                    try await Task.sleep(for: .milliseconds(2))
                }
                #expect(store.instances.map(\.host) == [expected])
                #expect(!store.isLoading)
            } catch {
                store.stop()
                await fixture.stop()
                throw error
            }
            store.stop()
            await fixture.stop()
        }
    }

    @Test(arguments: [false, true])
    func `cached presence is unavailable immediately after selecting another Gateway`(failure: Bool) async throws {
        try await TestIsolation.withIsolatedState {
            let fixture = InstancesGatewayFixture()
            let store = InstancesStore(control: fixture.control)
            let refresh = Task { await store.refresh() }
            do {
                let read = try await fixture.waitForHeld()
                InstancesGatewayFixture.respond(read, failure: failure)
                await refresh.value
                #expect(!store.instances.isEmpty)
                fixture.revision.setValue(2)
                #expect(store.instances.isEmpty)
                #expect(store.lastError == nil)
                #expect(store.statusMessage == nil)
            } catch {
                refresh.cancel()
                await fixture.stop()
                await refresh.value
                throw error
            }
            await fixture.stop()
        }
    }

    @Test(arguments: [false, true])
    func `visible Instances pane drops old rows when the selected Gateway is unavailable`(
        initiallyUnavailable: Bool) async throws
    {
        try await TestIsolation.withIsolatedState {
            _ = AppKitTestSupport.application
            let fixture = InstancesGatewayFixture()
            fixture.endpointUnavailable.setValue(initiallyUnavailable)
            let store = InstancesStore(control: fixture.control)
            let hosting = NSHostingView(rootView: InstancesSettings(store: store))
            hosting.frame = NSRect(x: 0, y: 0, width: 900, height: 600)
            let window = NSWindow(contentRect: hosting.frame, styleMask: [.titled], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.contentView = hosting
            defer {
                store.stop()
                window.orderOut(nil)
                window.contentView = nil
                window.close()
            }
            window.orderFront(nil)
            hosting.layoutSubtreeIfNeeded()
            do {
                if !initiallyUnavailable {
                    try await InstancesGatewayFixture.respond(fixture.waitForHeld())
                }
                let previousContent = initiallyUnavailable ? "showing local fallback" : "Gateway A"
                let before = try await Self.waitForRenderedLabels(hosting) { labels in
                    labels.contains { $0.contains(previousContent) }
                }
                try #require(before.contains { $0.contains(previousContent) })

                fixture.endpointUnavailable.setValue(true)
                fixture.revision.setValue(2)
                fixture.control.endpointDidChange(.unavailable(
                    mode: .remote, reason: "Synthetic Gateway B unavailable", routeRevision: 2))
                let after = try await Self.waitForRenderedLabels(hosting) { labels in
                    !labels.contains { $0.contains(previousContent) }
                }
                #expect(after.contains("Connected Instances"))
                #expect(!after.contains { $0.contains(previousContent) })
                #expect(!fixture.requests.value.contains { $0.owner == "B" })
            } catch {
                store.stop()
                await fixture.stop()
                throw error
            }
            store.stop()
            await fixture.stop()
        }
    }

    private static func waitForRenderedLabels(
        _ hosting: NSView,
        until condition: ([String]) -> Bool) async throws -> [String]
    {
        var labels: [String] = []
        let deadline = ContinuousClock.now + .seconds(3)
        repeat {
            hosting.layoutSubtreeIfNeeded()
            hosting.window?.displayIfNeeded()
            labels = try await instancesAccessibilityLabels(hosting)
            if condition(labels) { return labels }
            try await Task.sleep(for: .milliseconds(20))
        } while ContinuousClock.now < deadline
        return labels
    }
}

@MainActor
private func instancesAccessibilityLabels(_ root: NSView) async throws -> [String] {
    // Materialize SwiftUI's lazy AX tree through a real client request while MainActor can answer.
    let result = await Task.detached {
        let application = AXUIElementCreateApplication(ProcessInfo.processInfo.processIdentifier)
        var windows: CFTypeRef?
        return AXUIElementCopyAttributeValue(application, kAXWindowsAttribute as CFString, &windows)
    }.value
    try #require(result == .success)
    var labels: [String] = []
    var visited = Set<ObjectIdentifier>()
    func visit(_ element: AnyObject) throws {
        guard visited.insert(ObjectIdentifier(element)).inserted else { return }
        let value: Any? = element.accessibilityValue?()
        labels.append(contentsOf: [
            element.accessibilityLabel?(),
            element.accessibilityTitle?(),
            value as? String,
        ].compactMap(\.self))
        let children: [Any]? = element.accessibilityChildren?()
        for child in children ?? [] {
            try visit(child as AnyObject)
        }
        // AppKit-backed List rows can sit outside the hosting view's virtual AX children.
        if let view = element as? NSView {
            for child in view.subviews where !child.isHidden {
                try visit(child)
            }
        }
    }
    try visit(root)
    return labels
}

@MainActor
private final class InstancesGatewayFixture {
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
    let holdHealth = LockIsolated(false)
    let holdPreflight = LockIsolated(true)
    let endpointUnavailable = LockIsolated(false)
    let gateway: GatewayConnection
    let control: ControlChannel
    private let previousAccent = AppStateStore.shared.profileAccentHex
    private let previousMainKey = WorkActivityStore.shared.mainSessionKey
    private let previousMode = AppStateStore.shared.connectionMode

    init(
        holding heldMethod: String = "system-presence",
        endpointGate: GatewayConnectionSuspensionGate? = nil)
    {
        // The synthetic transport owns no local process; dedicated recovery tests own that handoff.
        AppStateStore.shared.connectionMode = .unconfigured
        let revision = self.revision
        let requests = self.requests
        let held = self.held
        let holdHealth = self.holdHealth
        let holdPreflight = self.holdPreflight
        let endpointUnavailable = self.endpointUnavailable
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
                if request.method == heldMethod, heldMethod != "health" || holdHealth.value,
                   !isPreflight || holdPreflight.value
                {
                    held.setValue(request)
                } else {
                    Self.respond(request)
                }
            })
        })
        self.gateway = GatewayConnection(
            testEndpointProvider: {
                await endpointGate?.suspend()
                if endpointUnavailable.value { throw URLError(.cannotConnectToHost) }
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
             "error":{"code":"INVALID_REQUEST","message":"synthetic presence failure"}}
            """#
        } else {
            let payload = if request.method == "system-presence" {
                #"[{"host":"Gateway \#(request.owner)","text":"Gateway \#(request.owner)","ts":1800000000000}]"#
            } else {
                #"""
                {"ok":true,"ts":1800000000000,"durationMs":1,
                 "channels":{"fixture":{"linked":true}},"channelOrder":["fixture"],
                 "channelLabels":{"fixture":"Gateway \#(request.owner)"},
                 "sessions":{"path":"/synthetic","count":0,"recent":[]}}
                """#
            }
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
            let fixture = InstancesGatewayFixture(holding: "health")
            _ = try await fixture.gateway.acquireServerLease()
            fixture.holdHealth.setValue(true)
            let store = HealthStore(control: fixture.control)
            let refresh = Task { await store.refresh(onDemand: true) }
            func cleanup() async {
                refresh.cancel()
                await fixture.stop()
                await refresh.value
            }
            do {
                let deadline = ContinuousClock.now + .seconds(2)
                while fixture.held.value == nil, ContinuousClock.now < deadline {
                    try await Task.sleep(for: .milliseconds(2))
                }
                let held = try #require(fixture.held.value)
                if replaceGateway { fixture.revision.setValue(2) }
                InstancesGatewayFixture.respond(held, failure: failHealth)
                await refresh.value
                #expect(!store.isRefreshing)
                if replaceGateway {
                    #expect(store.snapshot == nil)
                    #expect(store.lastSuccess == nil)
                    #expect(store.lastError == nil)
                } else if failHealth {
                    #expect(store.lastError != nil)
                    #expect(store.snapshot == nil)
                } else {
                    #expect(store.snapshot?.channelLabels?["fixture"] == "Gateway A")
                    #expect(store.lastSuccess != nil)
                    #expect(store.lastError == nil)
                    #expect(fixture.control.lastPingMs != nil)
                }
            } catch {
                await cleanup()
                throw error
            }
            await cleanup()
        }
    }

    @Test
    func `replacement health refresh owns loading and publication`() async throws {
        try await TestIsolation.withIsolatedState {
            let fixture = InstancesGatewayFixture(holding: "health")
            _ = try await fixture.gateway.acquireServerLease()
            fixture.holdHealth.setValue(true)
            let store = HealthStore(control: fixture.control)
            let first = Task { await store.refresh() }
            var second: Task<Void, Never>?
            do {
                let a = try await fixture.waitForHeld()
                fixture.revision.setValue(2)
                let bRefresh = Task { await store.refresh() }
                second = bRefresh
                let bBootstrap = try await fixture.waitForHeld(after: a.id)
                InstancesGatewayFixture.respond(bBootstrap)
                let b = try await fixture.waitForHeld(after: bBootstrap.id)
                InstancesGatewayFixture.respond(a)
                await first.value
                #expect(store.isRefreshing)
                #expect(store.snapshot == nil)
                InstancesGatewayFixture.respond(b)
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
            let fixture = InstancesGatewayFixture(holding: "health")
            let store = HealthStore(control: fixture.control)
            await store.refresh()
            let lease = try #require(await fixture.gateway.captureServerLease())
            let previousSuccess = store.lastSuccess
            let socket = try #require(fixture.requests.value.last?.socket)
            socket.emitReceiveFailure()
            let deadline = ContinuousClock.now + .seconds(2)
            while fixture.gateway.serverLeaseMatchesCurrentState(lease), ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(2))
            }
            #expect(!fixture.gateway.serverLeaseMatchesCurrentState(lease))
            fixture.holdHealth.setValue(true)
            let refresh = Task { await store.refresh() }
            do {
                let first = try await fixture.waitForHeld()
                #expect(store.snapshot?.channelLabels?["fixture"] == "Gateway A")
                #expect(store.lastSuccess == previousSuccess)
                let read: InstancesGatewayFixture.Request
                if first.isPreflight {
                    InstancesGatewayFixture.respond(first)
                    read = try await fixture.waitForHeld(after: first.id)
                } else {
                    read = first
                }
                InstancesGatewayFixture.respond(read, failure: true)
                await refresh.value
                #expect(store.snapshot?.channelLabels?["fixture"] == "Gateway A")
                #expect(store.lastSuccess == previousSuccess)
                #expect(store.lastError != nil)
                fixture.revision.setValue(2)
                #expect(store.snapshot == nil)
                #expect(store.lastSuccess == nil)
                #expect(store.lastError == nil)
            } catch {
                refresh.cancel()
                await fixture.stop()
                await refresh.value
                throw error
            }
            await fixture.stop()
        }
    }

    @Test
    func `health subscription refreshes replacement hello without losing bootstrap`() async throws {
        try await TestIsolation.withIsolatedState {
            let fixture = InstancesGatewayFixture(holding: "health")
            fixture.holdPreflight.setValue(false)
            fixture.holdHealth.setValue(true)
            let store = HealthStore(control: fixture.control)
            store.start()
            do {
                let a = try await fixture.waitForHeld()
                InstancesGatewayFixture.respond(a)
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
                #expect(store.lastSuccess == nil)
                InstancesGatewayFixture.respond(b)
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
            let fixture = InstancesGatewayFixture(holding: "health")
            fixture.holdPreflight.setValue(false)
            fixture.holdHealth.setValue(true)
            let store = HealthStore(control: fixture.control)
            store.start()
            var refresh: Task<Void, Never>?
            do {
                let initial = try await fixture.waitForHeld()
                InstancesGatewayFixture.respond(initial)
                let deadline = ContinuousClock.now + .seconds(2)
                while store.isRefreshing || store.snapshot == nil, ContinuousClock.now < deadline {
                    try await Task.sleep(for: .milliseconds(2))
                }
                try #require(store.snapshot?.channelLabels?["fixture"] == "Gateway A")
                try #require(!store.isRefreshing)
                let previousSuccess = store.lastSuccess
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
                #expect(store.lastSuccess == previousSuccess)
            } catch {
                refresh?.cancel()
                await fixture.stop()
                await refresh?.value
                throw error
            }
            await fixture.stop()
        }
    }

    @Test(arguments: [false, true])
    func `connection refresh keeps auth-source labels with their admitted Gateway`(replaceGateway: Bool) async throws {
        try await TestIsolation.withIsolatedState {
            let fixture = InstancesGatewayFixture(holding: "health")
            fixture.holdHealth.setValue(true)
            let refresh = Task { await fixture.control.refreshEndpoint(reason: "source ownership proof") }
            do {
                let a = try await fixture.waitForHeld()
                if replaceGateway { fixture.revision.setValue(2) }
                InstancesGatewayFixture.respond(a)
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
