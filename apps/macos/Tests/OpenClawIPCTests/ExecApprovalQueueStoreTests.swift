import Foundation
import Testing
@testable import OpenClaw
@testable import OpenClawKit

private struct ApprovalFixtureRequest: Encodable, Sendable {
    struct Command: Encodable, Sendable {
        let command: String
        let sessionKey: String?
        let allowedDecisions: [String]?
    }

    let id: String
    let request: Command
    let createdAtMs: Int
    let expiresAtMs: Int

    init(
        id: String,
        sessionKey: String = "main",
        command: String = "echo safe",
        createdOffsetMs: Int = 0,
        expiresOffsetMs: Int = 60000,
        allowedDecisions: [String]? = nil)
    {
        let nowMs = Int(Date().timeIntervalSince1970 * 1000)
        self.id = id
        self.request = Command(command: command, sessionKey: sessionKey, allowedDecisions: allowedDecisions)
        self.createdAtMs = nowMs + createdOffsetMs
        self.expiresAtMs = nowMs + expiresOffsetMs
    }

    var json: String {
        String(decoding: try! JSONEncoder().encode(self), as: UTF8.self)
    }
}

private struct ApprovalGatewayRequest: Sendable {
    let id: String
    let method: String
    let approvalId: String?
    let decision: String?
    let kind: String?
}

private actor ApprovalGatewayRequestLog {
    private var listedRequests: [ApprovalFixtureRequest]
    private var requests: [ApprovalGatewayRequest] = []
    private var nextSequence = 0
    private var resolveRejection: String?

    init(initialRequests: [ApprovalFixtureRequest]) {
        self.listedRequests = initialRequests
    }

    func append(_ request: ApprovalGatewayRequest) {
        self.requests.append(request)
    }

    func requests(method: String) -> [ApprovalGatewayRequest] {
        self.requests.filter { $0.method == method }
    }

    func listResponse() -> String {
        String(decoding: try! JSONEncoder().encode(self.listedRequests), as: UTF8.self)
    }

    /// Simulates another client (the modal prompter) winning the resolution
    /// race server-side: resolves reject and the authoritative list is empty.
    func markResolvedElsewhere(reason: String = "APPROVAL_ALREADY_RESOLVED") {
        self.resolveRejection = reason
        self.listedRequests = []
    }

    func resolveRejectionReason() -> String? {
        self.resolveRejection
    }

    func nextEventSequence() -> Int {
        self.nextSequence += 1
        return self.nextSequence
    }
}

private final class ApprovalGatewayFixture: @unchecked Sendable {
    let requestLog: ApprovalGatewayRequestLog
    let session: GatewayTestWebSocketSession
    let gateway: GatewayConnection

    init(initialRequests: [ApprovalFixtureRequest] = []) {
        let requestLog = ApprovalGatewayRequestLog(initialRequests: initialRequests)
        self.requestLog = requestLog
        self.session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { socket, message, sendIndex in
                guard sendIndex > 0, let request = Self.decodeRequest(message) else { return }
                await requestLog.append(request)
                if request.method.hasSuffix("approval.resolve"),
                   let reason = await requestLog.resolveRejectionReason()
                {
                    let response =
                        #"{"type":"res","id":"\#(request.id)","ok":false,"error":{"message":"\#(reason)"}}"#
                    socket.emitReceiveSuccess(.data(Data(response.utf8)))
                    return
                }
                let payload = if request.method == "exec.approval.list" {
                    await requestLog.listResponse()
                } else {
                    #"{"ok":true}"#
                }
                let response = #"{"type":"res","id":"\#(request.id)","ok":true,"payload":\#(payload)}"#
                socket.emitReceiveSuccess(.data(Data(response.utf8)))
            })
        })
        self.gateway = GatewayConnection(
            configProvider: { (url: URL(string: "ws://127.0.0.1:1")!, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: self.session))
    }

    func sendEvent(name: String, payload: String) async throws {
        let socket = try await self.readySocket()
        let sequence = await self.requestLog.nextEventSequence()
        let event = #"{"type":"event","event":"\#(name)","seq":\#(sequence),"payload":\#(payload)}"#
        socket.emitReceiveSuccessOnce(.data(Data(event.utf8)))
    }

    private func readySocket() async throws -> GatewayTestWebSocketTask {
        let deadline = ContinuousClock.now + .seconds(2)
        while ContinuousClock.now < deadline {
            if let socket = self.session.latestTask(), socket.hasPendingReceiveHandler() {
                return socket
            }
            try await Task.sleep(for: .milliseconds(2))
        }
        return try #require(self.session.latestTask())
    }

    private static func decodeRequest(_ message: URLSessionWebSocketTask.Message) -> ApprovalGatewayRequest? {
        let data: Data? = switch message {
        case let .data(data): data
        case let .string(value): value.data(using: .utf8)
        @unknown default: nil
        }
        guard let data,
              let frame = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let id = frame["id"] as? String,
              let method = frame["method"] as? String
        else { return nil }
        let parameters = frame["params"] as? [String: Any]
        return ApprovalGatewayRequest(
            id: id,
            method: method,
            approvalId: parameters?["id"] as? String,
            decision: parameters?["decision"] as? String,
            kind: parameters?["kind"] as? String)
    }
}

@Suite(.serialized)
@MainActor
struct ExecApprovalQueueStoreTests {
    @Test func `refresh seeds direct gateway list and excludes expired approvals`() async {
        let fixture = ApprovalGatewayFixture(initialRequests: [
            ApprovalFixtureRequest(id: "later", sessionKey: "work", createdOffsetMs: 200),
            ApprovalFixtureRequest(id: "expired", expiresOffsetMs: -100),
            ApprovalFixtureRequest(id: "earlier", createdOffsetMs: -200),
        ])
        let store = ExecApprovalQueueStore(gateway: fixture.gateway)
        defer { store.stop() }

        await store.refresh()

        #expect(store.requests.map(\.id) == ["earlier", "later"])
        #expect(store.requests.last?.request.sessionKey == "work")
        #expect(store.requests.first?.allowedDecisions == [.allowOnce, .deny])
        #expect(await fixture.requestLog.requests(method: "exec.approval.list").count == 1)
    }

    @Test func `losing a resolution race re-syncs from the authoritative queue`() async throws {
        let fixture = ApprovalGatewayFixture(initialRequests: [
            ApprovalFixtureRequest(id: "contested"),
        ])
        let store = ExecApprovalQueueStore(gateway: fixture.gateway)
        defer { store.stop() }

        await store.refresh()
        let contested = try #require(store.requests.first)

        // The modal prompter (a second presentation surface on the same event
        // stream) resolves first; the gateway rejects this store's attempt.
        await fixture.requestLog.markResolvedElsewhere()
        await store.resolve(request: contested, decision: .deny)

        #expect(store.requests.isEmpty)
        #expect(await fixture.requestLog.requests(method: "exec.approval.list").count == 2)
    }

    @Test func `requested and resolved events update the shared queue`() async throws {
        let fixture = ApprovalGatewayFixture()
        let store = ExecApprovalQueueStore(gateway: fixture.gateway)
        defer { store.stop() }
        store.start()
        await store.refresh()

        let request = ApprovalFixtureRequest(id: "live", sessionKey: "agent:main:work")
        try await fixture.sendEvent(name: "exec.approval.requested", payload: request.json)
        try #require(await self.waitUntil { store.requests.map(\.id) == ["live"] })
        #expect(store.requests.first?.request.sessionKey == "agent:main:work")

        try await fixture.sendEvent(name: "exec.approval.resolved", payload: #"{"id":"live"}"#)
        try #require(await self.waitUntil { store.requests.isEmpty })
    }

    @Test func `expired requests disappear without a gateway resolution event`() async throws {
        let fixture = ApprovalGatewayFixture(initialRequests: [
            ApprovalFixtureRequest(id: "short-lived", expiresOffsetMs: 500),
        ])
        let store = ExecApprovalQueueStore(gateway: fixture.gateway)
        defer { store.stop() }

        await store.refresh()
        #expect(store.requests.map(\.id) == ["short-lived"])
        try #require(await self.waitUntil { store.requests.isEmpty })
    }

    @Test func `explicit decision policy excludes allow always and blocks unavailable decisions`() async {
        let fixture = ApprovalGatewayFixture(initialRequests: [
            ApprovalFixtureRequest(
                id: "deny-only",
                allowedDecisions: ["allow-always", "deny"]),
        ])
        let store = ExecApprovalQueueStore(gateway: fixture.gateway)
        defer { store.stop() }
        await store.refresh()
        guard let request = store.requests.first else {
            Issue.record("Expected the pending approval to be listed")
            return
        }

        #expect(request.allowedDecisions == [.deny])
        await store.resolve(request: request, decision: .allowAlways)
        await store.resolve(request: request, decision: .allowOnce)
        #expect(await fixture.requestLog.requests(method: "exec.approval.resolve").isEmpty)

        await store.resolve(request: request, decision: .deny)
        let resolution = await fixture.requestLog.requests(method: "exec.approval.resolve")
        #expect(resolution.count == 1)
        #expect(resolution.first?.approvalId == "deny-only")
        #expect(resolution.first?.decision == "deny")
        #expect(store.requests.isEmpty)
    }

    @Test func `system agent approvals resolve through the unified kind-aware gateway method`() async throws {
        let fixture = ApprovalGatewayFixture()
        let store = ExecApprovalQueueStore(gateway: fixture.gateway)
        defer { store.stop() }
        store.start()
        await store.refresh()

        let request = ApprovalFixtureRequest(id: "system", allowedDecisions: ["allow-once", "deny"])
        try await fixture.sendEvent(name: "openclaw.approval.requested", payload: request.json)
        try #require(await self.waitUntil { store.requests.first?.id == "system" })
        let queued = try #require(store.requests.first)

        await store.resolve(request: queued, decision: .allowOnce)

        let resolution = await fixture.requestLog.requests(method: "approval.resolve")
        #expect(resolution.count == 1)
        #expect(resolution.first?.approvalId == "system")
        #expect(resolution.first?.decision == "allow-once")
        #expect(resolution.first?.kind == "system-agent")
        #expect(store.requests.isEmpty)
    }

    private func waitUntil(
        timeout: Duration = .seconds(2),
        _ predicate: @escaping @MainActor () -> Bool) async -> Bool
    {
        let deadline = ContinuousClock.now + timeout
        while ContinuousClock.now < deadline {
            if predicate() {
                return true
            }
            try? await Task.sleep(for: .milliseconds(5))
        }
        return predicate()
    }
}
