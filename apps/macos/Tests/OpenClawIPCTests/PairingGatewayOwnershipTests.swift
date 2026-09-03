import AppKit
import ConcurrencyExtras
import Foundation
import Observation
import Testing
@testable import OpenClaw
@testable import OpenClawKit

private final class PairingListReplyGate: @unchecked Sendable {
    let isWaiting = LockIsolated(false)
    private struct State {
        var released = false
        var continuation: CheckedContinuation<Void, Never>?
    }

    private let state = LockIsolated(State())

    func wait() async {
        await withCheckedContinuation { continuation in
            let released = self.state.withValue { state in
                guard !state.released else { return true }
                state.continuation = continuation
                return false
            }
            if released { continuation.resume() }
            self.isWaiting.setValue(true)
        }
    }

    func resume() {
        let continuation = self.state.withValue { state in
            state.released = true
            defer { state.continuation = nil }
            return state.continuation
        }
        continuation?.resume()
    }
}

private final class PairingGatewayFixture: @unchecked Sendable {
    struct Decision: Equatable, Sendable {
        let server: UInt64
        let method: String
    }

    let revision = LockIsolated<UInt64>(1)
    let decisions = LockIsolated<[Decision]>([])
    let pending = LockIsolated(true)
    let additionalPendingRequestIds = LockIsolated<[String]>([])
    let listReads = LockIsolated(0)
    let nextListGate = LockIsolated<PairingListReplyGate?>(nil)
    let session: GatewayTestWebSocketSession
    let gateway: GatewayConnection

    init() {
        let revision = self.revision
        let decisions = self.decisions
        let pending = self.pending
        let additionalPendingRequestIds = self.additionalPendingRequestIds
        let listReads = self.listReads
        let nextListGate = self.nextListGate
        let session = GatewayTestWebSocketSession {
            let server = revision.value
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
                      let method = frame["method"] as? String
                else { return }
                if method.hasSuffix(".approve") || method.hasSuffix(".reject") {
                    decisions.withValue { $0.append(Decision(server: server, method: method)) }
                }
                let payload: String
                if method.hasSuffix(".pair.list") {
                    let requests = (pending.value ? [Self.pendingRequest(server: server)] : []) +
                        additionalPendingRequestIds.value.map { Self.pendingRequest(server: server, requestId: $0) }
                    payload = #"{"pending":[\#(requests.joined(separator: ","))],"paired":[]}"#
                    listReads.withValue { $0 += 1 }
                    let gate = nextListGate.withValue { value in
                        defer { value = nil }
                        return value
                    }
                    await gate?.wait()
                } else {
                    payload = #"{"ok":true}"#
                }
                let response = #"{"type":"res","id":"\#(id)","ok":true,"payload":\#(payload)}"#
                socket.emitReceiveSuccess(.data(Data(response.utf8)))
            })
        }
        self.session = session
        self.gateway = GatewayConnection(
            testEndpointProvider: {
                let value = revision.value
                return GatewayConnection.EndpointSnapshot(
                    config: (url: URL(string: "ws://127.0.0.1:\(32000 + value)")!, token: nil, password: nil),
                    routeAuthority: value,
                    revision: value)
            },
            currentEndpointRevision: { revision.value },
            sessionBox: WebSocketSessionBox(session: session))
    }

    static func pendingRequest(server: UInt64 = 1, requestId: String = "same-request") -> String {
        #"""
        {"requestId":"\#(requestId)","nodeId":"\#(requestId)-node","deviceId":"\#(requestId)-device",
         "publicKey":"synthetic","displayName":"Gateway \#(server)","silent":false,"ts":1800000000000}
        """#
    }
}

@Suite(.serialized)
@MainActor
struct PairingGatewayOwnershipTests {
    @Test(arguments: PairingApprovalCenter.Kind.allCases, [PairingApprovalCenter.Decision.approve, .reject])
    func `a retained pairing card cannot decide on a replacement gateway`(
        kind: PairingApprovalCenter.Kind,
        decision: PairingApprovalCenter.Decision) async throws
    {
        try await self.withPrompter(kind: kind) { fixture, center, _ in
            try await self.waitUntil("initial card") { center.cards.count == 1 }
            let retained = try #require(center.cards.first)
            #expect(retained.displayName == "Gateway 1")

            // Change the authoritative selection before its socket or the queued
            // UI task catches up. Request ids are intentionally identical on B.
            fixture.revision.setValue(2)
            center.decide(retained, decision)
            try await self.waitUntil("decision completion") { center.decisionsInFlight.isEmpty }
            #expect(fixture.decisions.value.isEmpty)

            _ = try await fixture.gateway.acquireServerLease()
            try await self.waitUntil("replacement card") { center.cards.first?.displayName == "Gateway 2" }
            let replacement = try #require(center.cards.first)
            center.decide(replacement, decision)
            try await self.waitUntil("decision completion") { center.decisionsInFlight.isEmpty }
            let suffix = decision == .approve ? "approve" : "reject"
            #expect(fixture.decisions.value == [.init(server: 2, method: "\(kind.rawValue).pair.\(suffix)")])
        }
    }

    @Test func `a node list captured before resolution cannot resurrect its card`() async throws {
        try await self.withPrompter(kind: .node) { fixture, center, node in
            let gate = PairingListReplyGate()
            defer { gate.resume() }
            try await self
                .waitUntil("initial card and periodic list") { center.cards.count == 1 && fixture.listReads.value >= 2 }
            let socket = try #require(fixture.session.latestTask())
            fixture.nextListGate.setValue(gate)
            try await self.waitUntil("receive handler") { socket.hasPendingReceiveHandler() }
            socket.emitReceiveSuccessOnce(.string(
                #"""
                {"type":"event","event":"node.pair.requested",
                 "payload":\#(PairingGatewayFixture.pendingRequest()),"seq":1}
                """#))
            try await self.waitUntil("held list reply") { gate.isWaiting.value }
            fixture.pending.setValue(false)
            try await self.waitUntil("receive handler") { socket.hasPendingReceiveHandler() }
            socket.emitReceiveSuccessOnce(.string(
                #"""
                {"type":"event","event":"node.pair.resolved",
                 "payload":{"requestId":"same-request","decision":"rejected","ts":1800000000001},"seq":2}
                """#))
            try await self.waitUntil("authoritative resolution") { center.cards.isEmpty }
            let countChanged = LockIsolated(false)
            withObservationTracking { _ = node.pendingCount } onChange: { countChanged.setValue(true) }
            gate.resume()
            // Drain the resumed response and its MainActor projection before
            // checking that authoritative resolution still owns the visible queue.
            _ = try await fixture.gateway.acquireServerLease()
            try await Task.sleep(for: .milliseconds(100))
            #expect(center.cards.isEmpty)
            #expect(node.pendingCount == 0)
            #expect(!countChanged.value)
        }
    }

    @Test(arguments: PairingApprovalCenter.Kind.allCases)
    func `an initial list invalidated by resolution still discovers unrelated requests`(
        kind: PairingApprovalCenter.Kind) async throws
    {
        let gate = PairingListReplyGate()
        defer { gate.resume() }
        try await self.withPrompter(
            kind: kind,
            prepare: { fixture in
                fixture.additionalPendingRequestIds.setValue(["untouched-request"])
                fixture.nextListGate.setValue(gate)
            },
            operation: { fixture, center, _ in
                try await self.waitUntil("held initial list") { gate.isWaiting.value }
                #expect(center.cards.isEmpty)
                let socket = try #require(fixture.session.latestTask())
                fixture.pending.setValue(false)
                try await self.waitUntil("receive handler") { socket.hasPendingReceiveHandler() }
                socket.emitReceiveSuccessOnce(.string(
                    #"""
                    {"type":"event","event":"\#(kind.rawValue).pair.resolved",
                     "payload":{"requestId":"same-request","decision":"rejected","ts":1800000000001},"seq":1}
                    """#))
                try await self.waitUntil("receive handler after resolution") { socket.hasPendingReceiveHandler() }
                _ = try await fixture.gateway.acquireServerLease()
                try await Task.sleep(for: .milliseconds(100))
                gate.resume()
                try await self.waitUntil("unrelated pending request after concurrent resolution") {
                    center.cards.map(\.requestId) == ["untouched-request"]
                }
                #expect(center.cards.allSatisfy { $0.source?.isCurrent == true })
            })
    }

    private func withPrompter(
        kind: PairingApprovalCenter.Kind,
        prepare: (PairingGatewayFixture) -> Void = { _ in },
        operation: (PairingGatewayFixture, PairingApprovalCenter, NodePairingApprovalPrompter) async throws -> Void)
        async throws
    {
        try await TestIsolation.withIsolatedState {
            _ = NSApplication.shared
            let fixture = PairingGatewayFixture()
            prepare(fixture)
            let center = PairingApprovalCenter()
            let node = NodePairingApprovalPrompter(gateway: fixture.gateway, center: center)
            let device = DevicePairingApprovalPrompter(gateway: fixture.gateway, center: center)
            switch kind {
            case .node: node.start()
            case .device: device.start()
            }
            do {
                try await operation(fixture, center, node)
            } catch {
                node.stop()
                device.stop()
                await fixture.gateway.shutdown()
                throw error
            }
            node.stop()
            device.stop()
            await fixture.gateway.shutdown()
        }
    }

    private func waitUntil(_ phase: String, _ predicate: @MainActor () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(3)
        while !predicate(), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        try #require(predicate(), "Pairing phase: \(phase)")
    }
}
