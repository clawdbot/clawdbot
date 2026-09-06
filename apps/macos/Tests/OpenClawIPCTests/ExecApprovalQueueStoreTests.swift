import ConcurrencyExtras
import Foundation
import OpenClawProtocol
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
        sessionKey: String? = "main",
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
        get throws {
            try #require(String(data: JSONEncoder().encode(self), encoding: .utf8))
        }
    }
}

private struct ApprovalGatewayRequest: Sendable {
    let gatewayURL: URL
    let id: String
    let method: String
    let approvalId: String?
    let decision: String?
    let kind: String?
}

private actor ApprovalGatewayRequestLog {
    private var makeListedRequests: @Sendable () -> [ApprovalFixtureRequest]
    private var makeListedSystemRequests: @Sendable () -> [ApprovalFixtureRequest]
    private var requests: [ApprovalGatewayRequest] = []
    private var nextSequence = 0
    private var resolveRejection: String?
    private var unavailableMethods: Set<String> = []

    init(
        initialRequests: @escaping @Sendable () -> [ApprovalFixtureRequest],
        systemRequests: @escaping @Sendable () -> [ApprovalFixtureRequest])
    {
        self.makeListedRequests = initialRequests
        self.makeListedSystemRequests = systemRequests
    }

    func append(_ request: ApprovalGatewayRequest) {
        self.requests.append(request)
    }

    func requests(method: String) -> [ApprovalGatewayRequest] {
        self.requests.filter { $0.method == method }
    }

    func listResponse(method: String) throws -> String {
        // Start fixture lifetimes at the Gateway response, after cold connection work.
        let requests = method == "openclaw.approval.list" ? self.makeListedSystemRequests() : self.makeListedRequests()
        return try #require(String(data: JSONEncoder().encode(requests), encoding: .utf8))
    }

    func setListedRequests(_ requests: @escaping @Sendable () -> [ApprovalFixtureRequest]) {
        self.makeListedRequests = requests
    }

    /// Simulates another client (the modal prompter) winning the resolution
    /// race server-side: resolves reject and the authoritative list is empty.
    func markResolvedElsewhere(reason: String = "APPROVAL_ALREADY_RESOLVED") {
        self.resolveRejection = reason
        self.makeListedRequests = { [] }
    }

    func resolveRejectionReason() -> String? {
        self.resolveRejection
    }

    func rejectTemporarily(methods: Set<String>) {
        self.unavailableMethods = methods
    }

    func isUnavailable(method: String) -> Bool {
        self.unavailableMethods.contains(method)
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

    init(
        initialRequests: @escaping @Sendable () -> [ApprovalFixtureRequest] = { [] },
        systemRequests: @escaping @Sendable () -> [ApprovalFixtureRequest] = { [] },
        advertisedMethods: [String] = [],
        listResponseDelay: Duration = .zero,
        beforeListResponse: (@Sendable () async -> Void)? = nil,
        gatewayURL: @escaping @Sendable () -> URL = { URL(string: "ws://127.0.0.1:1")! })
    {
        let requestLog = ApprovalGatewayRequestLog(initialRequests: initialRequests, systemRequests: systemRequests)
        self.requestLog = requestLog
        self.session = GatewayTestWebSocketSession(taskFactory: {
            let connectionURL = gatewayURL()
            return GatewayTestWebSocketTask(sendHook: { socket, message, sendIndex in
                guard sendIndex > 0,
                      let request = Self.decodeRequest(message, gatewayURL: connectionURL)
                else { return }
                await requestLog.append(request)
                if await requestLog.isUnavailable(method: request.method) {
                    let response = ResponseFrame(
                        type: "res",
                        id: request.id,
                        ok: false,
                        error: ErrorShape(code: "UNAVAILABLE", message: "temporary fixture failure"))
                    try socket.emitReceiveSuccess(.data(JSONEncoder().encode(response)))
                    return
                }
                if request.method.hasSuffix("approval.resolve"),
                   let reason = await requestLog.resolveRejectionReason()
                {
                    let response = ResponseFrame(
                        type: "res",
                        id: request.id,
                        ok: false,
                        error: ErrorShape(
                            code: "INVALID_REQUEST",
                            message: "approval already resolved",
                            details: .init(["reason": reason])))
                    try socket.emitReceiveSuccess(.data(JSONEncoder().encode(response)))
                    return
                }
                if request.method == "exec.approval.list", listResponseDelay > .zero {
                    try await Task.sleep(for: listResponseDelay)
                }
                let payload = if request.method.hasSuffix(".approval.list") {
                    try await requestLog.listResponse(method: request.method)
                } else {
                    #"{"ok":true}"#
                }
                if request.method.hasSuffix(".approval.list") {
                    await beforeListResponse?()
                }
                let response = #"{"type":"res","id":"\#(request.id)","ok":true,"payload":\#(payload)}"#
                socket.emitReceiveSuccess(.data(Data(response.utf8)))
            }, receiveHook: { socket, receiveIndex in
                if receiveIndex == 0 {
                    return .data(GatewayWebSocketTestSupport.connectChallengeData())
                }
                return .data(GatewayWebSocketTestSupport.connectOkData(
                    id: socket.snapshotConnectRequestID() ?? "connect",
                    methods: advertisedMethods))
            })
        })
        self.gateway = GatewayConnection(
            configProvider: { (url: gatewayURL(), token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: self.session))
    }

    @MainActor
    func withStore(_ body: @MainActor (ExecApprovalQueueStore) async throws -> Void) async rethrows {
        let store = ExecApprovalQueueStore(gateway: gateway)
        do {
            try await body(store)
        } catch {
            store.stop()
            await self.gateway.shutdown()
            throw error
        }
        store.stop()
        await self.gateway.shutdown()
    }

    func sendEvent(name: String, payload: String) async throws {
        let socket = try await readySocket()
        let sequence = await requestLog.nextEventSequence()
        let event = #"{"type":"event","event":"\#(name)","seq":\#(sequence),"payload":\#(payload)}"#
        socket.emitReceiveSuccess(.data(Data(event.utf8)))
    }

    private func readySocket() async throws -> GatewayTestWebSocketTask {
        let deadline = ContinuousClock.now + .seconds(2)
        while ContinuousClock.now < deadline {
            if let socket = session.latestTask(), socket.hasPendingReceiveHandler() {
                return socket
            }
            try await Task.sleep(for: .milliseconds(2))
        }
        return try #require(self.session.latestTask())
    }

    private static func decodeRequest(
        _ message: URLSessionWebSocketTask.Message,
        gatewayURL: URL) -> ApprovalGatewayRequest?
    {
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
            gatewayURL: gatewayURL,
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
    @Test(arguments: [false, true])
    func `captured approval cannot resolve through another gateway`(refreshReplacement: Bool) async throws {
        let urlA = try #require(URL(string: "ws://127.0.0.1:49240/"))
        let urlB = try #require(URL(string: "ws://127.0.0.1:49241/"))
        let source = LockIsolated(urlA)
        let fixture = ApprovalGatewayFixture(
            initialRequests: { [ApprovalFixtureRequest(id: "shared-id", command: "echo gateway-a")] },
            gatewayURL: { source.value })
        try await fixture.withStore { store in
            await store.refresh()
            let capturedA = try #require(store.requests.first)
            #expect(capturedA.request.command == "echo gateway-a")

            source.withValue { $0 = urlB }
            try await fixture.gateway.refresh()
            await fixture.requestLog.setListedRequests {
                [ApprovalFixtureRequest(id: "shared-id", command: "echo gateway-b")]
            }
            if refreshReplacement {
                await store.refresh()
                #expect(store.requests.first?.request.command == "echo gateway-b")
            }

            // A menu button retains the displayed item before its Task starts.
            // The same server-local id may now describe a different command on B.
            await store.resolve(request: capturedA, decision: .deny)
            #expect(await fixture.requestLog.requests(method: "exec.approval.resolve").isEmpty)
            if refreshReplacement {
                #expect(store.requests.first?.request.command == "echo gateway-b")
            }

            await store.refresh()
            let currentB = try #require(store.requests.first)
            await store.resolve(request: currentB, decision: .allowOnce)
            let resolutions = await fixture.requestLog.requests(method: "exec.approval.resolve")
            #expect(resolutions.count == 1)
            #expect(resolutions.first?.gatewayURL == urlB)
            #expect(resolutions.first?.decision == "allow-once")
        }
    }

    @Test func `refresh seeds direct gateway list and excludes expired approvals`() async {
        let fixture = ApprovalGatewayFixture(initialRequests: {
            [
                ApprovalFixtureRequest(id: "later", sessionKey: "work", createdOffsetMs: 200),
                ApprovalFixtureRequest(id: "expired", expiresOffsetMs: -100),
                ApprovalFixtureRequest(id: "earlier", createdOffsetMs: -200),
            ]
        })
        await fixture.withStore { store in
            await store.refresh()

            #expect(store.requests.map(\.id) == ["earlier", "later"])
            #expect(store.requests.last?.request.sessionKey == "work")
            #expect(store.requests.first?.allowedDecisions == [.allowOnce, .deny])
            #expect(await fixture.requestLog.requests(method: "exec.approval.list").count == 1)
        }
    }

    @Test func `losing a resolution race re-syncs from the authoritative queue`() async throws {
        let fixture = ApprovalGatewayFixture(initialRequests: {
            [ApprovalFixtureRequest(id: "contested")]
        })
        try await fixture.withStore { store in
            await store.refresh()
            let contested = try #require(store.requests.first)

            // The modal prompter (a second presentation surface on the same event
            // stream) resolves first; the gateway rejects this store's attempt.
            await fixture.requestLog.markResolvedElsewhere()
            // A malformed response can also trigger timeout recovery; require a decoded rejection.
            let rejection = try await #require(throws: GatewayResponseError.self) {
                try await fixture.gateway.requestVoid(
                    method: .execApprovalResolve,
                    params: ["id": .init(contested.id), "decision": .init("deny")],
                    timeoutMs: 10000)
            }
            #expect(rejection.code == "INVALID_REQUEST")
            #expect(rejection.detailsReason == "APPROVAL_ALREADY_RESOLVED")

            await store.resolve(request: contested, decision: .deny)

            #expect(store.requests.isEmpty)
            #expect(await fixture.requestLog.requests(method: "exec.approval.list").count == 2)
        }
    }

    @Test func `temporary resolve and list failures preserve the current gateway approval`() async throws {
        let fixture = ApprovalGatewayFixture(initialRequests: {
            [ApprovalFixtureRequest(id: "pending")]
        })
        try await fixture.withStore { store in
            await store.refresh()
            let request = try #require(store.requests.first)
            await fixture.requestLog.rejectTemporarily(methods: ["exec.approval.resolve", "exec.approval.list"])

            await store.resolve(request: request, decision: .deny)

            #expect(store.requests.map(\.id) == ["pending"])
            #expect(await fixture.requestLog.requests(method: "exec.approval.resolve").count == 1)
            #expect(await fixture.requestLog.requests(method: "exec.approval.list").count == 2)

            await fixture.requestLog.rejectTemporarily(methods: [])
            await store.resolve(request: request, decision: .allowOnce)
            #expect(store.requests.isEmpty)
            #expect(await fixture.requestLog.requests(method: "exec.approval.resolve").count == 2)
        }
    }

    @Test func `requested and resolved events update the shared queue`() async throws {
        let fixture = ApprovalGatewayFixture()
        try await fixture.withStore { store in
            store.start()
            await store.refresh()

            let request = ApprovalFixtureRequest(id: "live", sessionKey: "agent:main:work")
            try await fixture.sendEvent(name: "exec.approval.requested", payload: request.json)
            try #require(await self.waitUntil { store.requests.map(\.id) == ["live"] })
            #expect(store.requests.first?.request.sessionKey == "agent:main:work")

            try await fixture.sendEvent(name: "exec.approval.resolved", payload: #"{"id":"live"}"#)
            try #require(await self.waitUntil { store.requests.isEmpty })
        }
    }

    @Test func `expiry keeps its deadline when the main actor delays task startup`() async {
        // The child owns the actor stall so parallel suites keep their own deadlines.
        await #expect(processExitsWith: .success) {
            for listResponseDelayMs in [0, 600] {
                try await ExecApprovalQueueStoreTests.checkDelayedExpiry(listResponseDelayMs: listResponseDelayMs)
            }
        }
    }

    private static func checkDelayedExpiry(listResponseDelayMs: Int) async throws {
        let fixture = ApprovalGatewayFixture(initialRequests: {
            [ApprovalFixtureRequest(id: "delayed-expiry-task", expiresOffsetMs: 3000)]
        }, listResponseDelay: .milliseconds(listResponseDelayMs))
        try await fixture.withStore { store in
            await store.refresh()
            #expect(
                store.requests.map(\.id) == ["delayed-expiry-task"],
                "list response delay: \(listResponseDelayMs) ms")
            let request = try #require(store.requests.first)
            // Hold the actor past the published deadline before the queued expiry task can start.
            Self.blockUntilExpiry(request.expiresAtMs)
            try #require(
                await Self().waitUntil { store.requests.isEmpty },
                "list response delay: \(listResponseDelayMs) ms")
        }
    }

    private static func blockUntilExpiry(_ expiresAtMs: Int) {
        Thread.sleep(until: Date(timeIntervalSince1970: Double(expiresAtMs) / 1000))
    }

    @Test func `explicit decision policy excludes allow always and blocks unavailable decisions`() async {
        let fixture = ApprovalGatewayFixture(initialRequests: {
            [
                ApprovalFixtureRequest(
                    id: "deny-only",
                    allowedDecisions: ["allow-always", "deny"]),
            ]
        })
        await fixture.withStore { store in
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
    }

    @Test func `system agent approvals resolve through the unified kind-aware gateway method`() async throws {
        let fixture = ApprovalGatewayFixture(advertisedMethods: ["openclaw.approval.list"])
        try await fixture.withStore { store in
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
    }

    @Test(arguments: [false, true])
    func `reconnect reloads advertised system approvals with current authority`(supportsSystemList: Bool) async throws {
        let fixture = ApprovalGatewayFixture(
            initialRequests: { [ApprovalFixtureRequest(id: "exec-pending")] },
            systemRequests: { [ApprovalFixtureRequest(id: "system-pending", command: "echo recovered")] },
            advertisedMethods: supportsSystemList ? ["openclaw.approval.list"] : [])
        try await fixture.withStore { store in
            store.start()
            await store.refresh()
            var captured: ExecApprovalQueueItem?
            if supportsSystemList {
                let event = ApprovalFixtureRequest(id: "system-pending", command: "echo before-reconnect")
                try await fixture.sendEvent(name: "openclaw.approval.requested", payload: event.json)
                try #require(await self.waitUntil {
                    store.requests.contains { $0.request.command == "echo before-reconnect" }
                })
                await store.refresh()
                captured = try #require(store.requests.first { $0.kind == .systemAgent })
            }

            await fixture.gateway.shutdown()
            await store.refresh()
            #expect(fixture.session.snapshotMakeCount() == 2)
            if let captured {
                await store.resolve(request: captured, decision: .deny)
            }
            #expect(await fixture.requestLog.requests(method: "approval.resolve").isEmpty)
            #expect(await fixture.requestLog.requests(method: "openclaw.approval.list").count ==
                (supportsSystemList ? 3 : 0))

            if supportsSystemList {
                let recovered = try #require(store.requests.first { $0.kind == .systemAgent })
                #expect(recovered.request.command == "echo recovered")
                await store.resolve(request: recovered, decision: .allowOnce)
                #expect(await fixture.requestLog.requests(method: "approval.resolve").count == 1)
            } else {
                #expect(store.requests.allSatisfy { $0.kind == .exec })
            }
            let exec = try #require(store.requests.first { $0.kind == .exec })
            await store.resolve(request: exec, decision: .allowOnce)
            #expect(store.requests.isEmpty)
        }
    }

    @Test func `a replacement hello reloads both approval kinds without reopening the menu`() async throws {
        let phase = LockIsolated("before")
        let fixture = ApprovalGatewayFixture(
            initialRequests: { [ApprovalFixtureRequest(id: "exec-pending", command: "exec-\(phase.value)")] },
            systemRequests: { [ApprovalFixtureRequest(id: "system-pending", command: "system-\(phase.value)")] },
            advertisedMethods: ["openclaw.approval.list"])
        try await fixture.withStore { store in
            store.start()
            await store.refresh()
            #expect(Set(store.requests.map(\.request.command)) == ["exec-before", "system-before"])

            phase.withValue { $0 = "after" }
            await fixture.gateway.shutdown()
            _ = try await fixture.gateway.acquireServerLease()

            try #require(await self.waitUntil {
                Set(store.requests.map(\.request.command)) == ["exec-after", "system-after"]
            })
        }
    }

    @Test func `overlapping refreshes cannot replace a newer approval event`() async throws {
        let holdResponse = LockIsolated(false)
        let responseCaptured = LockIsolated(false)
        let releaseResponse = AsyncTestGate()
        let fixture = ApprovalGatewayFixture(
            initialRequests: { [ApprovalFixtureRequest(id: "resolved-during-list")] },
            beforeListResponse: {
                guard holdResponse.value else { return }
                responseCaptured.withValue { $0 = true }
                await releaseResponse.wait()
            })
        try await fixture.withStore { store in
            store.start()
            await store.refresh()
            try #require(store.requests.count == 1)
            holdResponse.withValue { $0 = true }
            let first = Task { await store.refresh() }
            let second = Task { await store.refresh() }
            defer {
                first.cancel()
                second.cancel()
                releaseResponse.open()
            }
            try #require(await self.waitUntil { responseCaptured.value })

            await fixture.requestLog.setListedRequests { [] }
            try await fixture.sendEvent(
                name: "exec.approval.resolved",
                payload: #"{"id":"resolved-during-list"}"#)
            try #require(await self.waitUntil { store.requests.isEmpty })
            releaseResponse.open()
            await first.value
            await second.value
            #expect(store.requests.isEmpty)
        }
    }

    @Test func `initial reconciliation converges after a newer approval event`() async throws {
        let responseCaptured = LockIsolated(false)
        let releaseResponse = AsyncTestGate()
        let fixture = ApprovalGatewayFixture(
            initialRequests: {
                [ApprovalFixtureRequest(id: "resolved-during-list"), ApprovalFixtureRequest(id: "still-pending")]
            },
            beforeListResponse: {
                responseCaptured.withValue { $0 = true }
                await releaseResponse.wait()
            })
        defer { releaseResponse.open() }
        try await fixture.withStore { store in
            store.start()
            _ = try await fixture.gateway.acquireServerLease()
            try #require(await self.waitUntil { responseCaptured.value })

            let request = ApprovalFixtureRequest(id: "resolved-during-list")
            try await fixture.sendEvent(name: "exec.approval.requested", payload: request.json)
            try #require(await self.waitUntil { store.requests.map(\.id) == [request.id] })
            await fixture.requestLog.setListedRequests { [ApprovalFixtureRequest(id: "still-pending")] }
            try await fixture.sendEvent(name: "exec.approval.resolved", payload: #"{"id":"resolved-during-list"}"#)
            try #require(await self.waitUntil { store.requests.isEmpty })

            releaseResponse.open()
            try #require(await self.waitUntil { store.requests.map(\.id) == ["still-pending"] })
        }
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
