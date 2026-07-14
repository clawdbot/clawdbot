import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClawKit

extension NSLock {
    fileprivate func withLock<T>(_ body: () -> T) -> T {
        lock()
        defer { self.unlock() }
        return body()
    }
}

private final class InvokeCancellationFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false

    func markCancelled() {
        self.lock.withLock { self.cancelled = true }
    }

    func isCancelled() -> Bool {
        self.lock.withLock { self.cancelled }
    }
}

private actor StringCapture {
    private var value: String?

    func set(_ value: String?) {
        self.value = value
    }

    func get() -> String? {
        self.value
    }
}

private final class DoubleCallbackPingWebSocketTask: WebSocketTasking, @unchecked Sendable {
    private let callbacks: [Error?]

    init(callbacks: [Error?]) {
        self.callbacks = callbacks
    }

    var state: URLSessionTask.State {
        .running
    }

    func resume() {}

    func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        _ = (closeCode, reason)
    }

    func send(_ message: URLSessionWebSocketTask.Message) async throws {
        _ = message
    }

    func sendPing(pongReceiveHandler: @escaping @Sendable (Error?) -> Void) {
        for callback in self.callbacks {
            pongReceiveHandler(callback)
        }
    }

    func receive() async throws -> URLSessionWebSocketTask.Message {
        throw URLError(.badServerResponse)
    }

    func receive(
        completionHandler: @escaping @Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void)
    {
        completionHandler(.failure(URLError(.badServerResponse)))
    }
}

private final class FirstCancelGate: @unchecked Sendable {
    private let condition = NSCondition()
    private var shouldBlock = true
    private var started = false
    private var released = false

    func blockIfNeeded() {
        self.condition.lock()
        guard self.shouldBlock else {
            self.condition.unlock()
            return
        }
        self.shouldBlock = false
        self.started = true
        self.condition.broadcast()
        while !self.released {
            self.condition.wait()
        }
        self.condition.unlock()
    }

    func hasStarted() -> Bool {
        self.condition.lock()
        defer { self.condition.unlock() }
        return self.started
    }

    func release() {
        self.condition.lock()
        self.released = true
        self.condition.broadcast()
        self.condition.unlock()
    }
}

private final class FakeGatewayWebSocketTask: WebSocketTasking, @unchecked Sendable {
    private let lock = NSLock()
    private let helloAuth: [String: Any]?
    private let helloMethods: [String]
    private let helloSessionDefaults: [String: Any]?
    private let helloDelayNanoseconds: UInt64
    private let connectError: [String: Any]?
    private let cancelGate: FirstCancelGate?
    private var _state: URLSessionTask.State = .suspended
    private var connectRequestId: String?
    private var connectAuth: [String: Any]?
    private var connectDevice: [String: Any]?
    private var sentRequestMethods: [String] = []
    private var sentRequestPayloads: [[String: Any]] = []
    private var receivePhase = 0
    private var pendingReceiveHandler:
        (@Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void)?

    init(
        helloAuth: [String: Any]? = nil,
        helloMethods: [String] = [],
        helloSessionDefaults: [String: Any]? = nil,
        helloDelayNanoseconds: UInt64 = 0,
        connectError: [String: Any]? = nil,
        cancelGate: FirstCancelGate? = nil)
    {
        self.helloAuth = helloAuth
        self.helloMethods = helloMethods
        self.helloSessionDefaults = helloSessionDefaults
        self.helloDelayNanoseconds = helloDelayNanoseconds
        self.connectError = connectError
        self.cancelGate = cancelGate
    }

    var state: URLSessionTask.State {
        get { self.lock.withLock { self._state } }
        set { self.lock.withLock { self._state = newValue } }
    }

    func resume() {
        self.state = .running
    }

    func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        _ = (closeCode, reason)
        self.state = .canceling
        self.cancelGate?.blockIfNeeded()
        let handler = self.lock.withLock { () -> (@Sendable (Result<
            URLSessionWebSocketTask.Message,
            Error,
        >) -> Void)? in
            defer { self.pendingReceiveHandler = nil }
            return self.pendingReceiveHandler
        }
        handler?(Result<URLSessionWebSocketTask.Message, Error>.failure(URLError(.cancelled)))
    }

    func send(_ message: URLSessionWebSocketTask.Message) async throws {
        let data: Data? = switch message {
        case let .data(d): d
        case let .string(s): s.data(using: .utf8)
        @unknown default: nil
        }
        guard let data else { return }
        if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           obj["type"] as? String == "req",
           let method = obj["method"] as? String
        {
            self.lock.withLock {
                self.sentRequestMethods.append(method)
                self.sentRequestPayloads.append(obj)
            }
            guard method == "connect", let id = obj["id"] as? String else { return }
            let params = obj["params"] as? [String: Any]
            let auth = (params?["auth"] as? [String: Any]) ?? [:]
            let device = params?["device"] as? [String: Any]
            self.lock.withLock {
                self.connectRequestId = id
                self.connectAuth = auth
                self.connectDevice = device
            }
        }
    }

    func latestConnectAuth() -> [String: Any]? {
        self.lock.withLock { self.connectAuth }
    }

    func latestConnectDevice() -> [String: Any]? {
        self.lock.withLock { self.connectDevice }
    }

    func sentRequestCount(method: String) -> Int {
        self.lock.withLock { self.sentRequestMethods.count(where: { $0 == method }) }
    }

    func sentRequests(method: String) -> [[String: Any]] {
        self.lock.withLock {
            self.sentRequestPayloads.filter { $0["method"] as? String == method }
        }
    }

    func hasPendingReceiveHandler() -> Bool {
        self.lock.withLock { self.pendingReceiveHandler != nil }
    }

    func sendPing(pongReceiveHandler: @escaping @Sendable (Error?) -> Void) {
        pongReceiveHandler(nil)
    }

    func receive() async throws -> URLSessionWebSocketTask.Message {
        let phase = self.lock.withLock { () -> Int in
            let current = self.receivePhase
            self.receivePhase += 1
            return current
        }
        if phase == 0 {
            return .data(Self.connectChallengeData(nonce: "nonce-1"))
        }
        if self.helloDelayNanoseconds > 0 {
            try await Task.sleep(nanoseconds: self.helloDelayNanoseconds)
        }
        for _ in 0..<50 {
            let id = self.lock.withLock { self.connectRequestId }
            if let id {
                if let connectError {
                    return .data(Self.connectErrorData(id: id, error: connectError))
                }
                return .data(Self.connectOkData(
                    id: id,
                    auth: self.helloAuth,
                    methods: self.helloMethods,
                    sessionDefaults: self.helloSessionDefaults))
            }
            try await Task.sleep(nanoseconds: 1_000_000)
        }
        if let connectError {
            return .data(Self.connectErrorData(id: "connect", error: connectError))
        }
        return .data(Self.connectOkData(
            id: "connect",
            auth: self.helloAuth,
            methods: self.helloMethods,
            sessionDefaults: self.helloSessionDefaults))
    }

    func receive(
        completionHandler: @escaping @Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void)
    {
        self.lock.withLock { self.pendingReceiveHandler = completionHandler }
    }

    func emitReceiveFailure() {
        let handler = self.lock.withLock { () -> (@Sendable (Result<
            URLSessionWebSocketTask.Message,
            Error,
        >) -> Void)? in
            self._state = .canceling
            defer { self.pendingReceiveHandler = nil }
            return self.pendingReceiveHandler
        }
        handler?(Result<URLSessionWebSocketTask.Message, Error>.failure(URLError(.networkConnectionLost)))
    }

    func emitInvokeRequest(id: String, command: String, idempotencyKey: String? = nil) {
        self.emitInvokeRequest(
            id: id,
            command: command,
            paramsJSON: "{}",
            idempotencyKey: idempotencyKey)
    }

    func emitInvokeRequest(
        id: String,
        command: String,
        paramsJSON: String?,
        idempotencyKey: String? = nil)
    {
        let handler = self.lock.withLock { () -> (@Sendable (Result<
            URLSessionWebSocketTask.Message,
            Error,
        >) -> Void)? in
            defer { self.pendingReceiveHandler = nil }
            return self.pendingReceiveHandler
        }
        handler?(.success(.data(Self.invokeRequestData(
            id: id,
            command: command,
            paramsJSON: paramsJSON,
            idempotencyKey: idempotencyKey))))
    }

    private static func connectChallengeData(nonce: String) -> Data {
        let frame: [String: Any] = [
            "type": "event",
            "event": "connect.challenge",
            "payload": ["nonce": nonce],
        ]
        return (try? JSONSerialization.data(withJSONObject: frame)) ?? Data()
    }

    private static func connectOkData(
        id: String,
        auth: [String: Any]? = nil,
        methods: [String] = [],
        sessionDefaults: [String: Any]? = nil) -> Data
    {
        var payload: [String: Any] = [
            "type": "hello-ok",
            "protocol": 2,
            "server": [
                "version": "test",
                "connId": "test",
            ],
            "features": [
                "methods": methods,
                "events": [],
            ],
            "snapshot": [
                "presence": [["ts": 1]],
                "health": [:],
                "stateVersion": [
                    "presence": 0,
                    "health": 0,
                ],
                "uptimeMs": 0,
            ],
            "policy": [
                "maxPayload": 1,
                "maxBufferedBytes": 1,
                "tickIntervalMs": 30000,
            ],
            "auth": [:],
        ]
        if let auth {
            payload["auth"] = auth
        }
        if let sessionDefaults {
            payload["snapshot"] = [
                "presence": [["ts": 1]],
                "health": [:],
                "stateVersion": [
                    "presence": 0,
                    "health": 0,
                ],
                "uptimeMs": 0,
                "sessionDefaults": sessionDefaults,
            ]
        }
        let frame: [String: Any] = [
            "type": "res",
            "id": id,
            "ok": true,
            "payload": payload,
        ]
        return (try? JSONSerialization.data(withJSONObject: frame)) ?? Data()
    }

    private static func connectErrorData(id: String, error: [String: Any]) -> Data {
        let frame: [String: Any] = [
            "type": "res",
            "id": id,
            "ok": false,
            "error": error,
        ]
        return (try? JSONSerialization.data(withJSONObject: frame)) ?? Data()
    }

    private static func invokeRequestData(
        id: String,
        command: String,
        paramsJSON: String?,
        idempotencyKey: String?) -> Data
    {
        var payload: [String: Any] = [
            "id": id,
            "nodeId": "test-node",
            "command": command,
            "paramsJSON": paramsJSON ?? NSNull(),
        ]
        if let idempotencyKey {
            payload["idempotencyKey"] = idempotencyKey
        }
        let frame: [String: Any] = [
            "type": "event",
            "event": "node.invoke.request",
            "payload": payload,
        ]
        return (try? JSONSerialization.data(withJSONObject: frame)) ?? Data()
    }
}

private final class FakeGatewayWebSocketSession: WebSocketSessioning, @unchecked Sendable {
    private let lock = NSLock()
    private let helloAuth: [String: Any]?
    private let helloMethods: [String]
    private let helloSessionDefaults: [String: Any]?
    private let helloDelayNanoseconds: UInt64
    private let connectError: [String: Any]?
    private let cancelGate: FirstCancelGate?
    private var tasks: [FakeGatewayWebSocketTask] = []
    private var requests: [URLRequest] = []
    private var makeCount = 0

    init(
        helloAuth: [String: Any]? = nil,
        helloMethods: [String] = [],
        helloSessionDefaults: [String: Any]? = nil,
        helloDelayNanoseconds: UInt64 = 0,
        connectError: [String: Any]? = nil,
        cancelGate: FirstCancelGate? = nil)
    {
        self.helloAuth = helloAuth
        self.helloMethods = helloMethods
        self.helloSessionDefaults = helloSessionDefaults
        self.helloDelayNanoseconds = helloDelayNanoseconds
        self.connectError = connectError
        self.cancelGate = cancelGate
    }

    func snapshotMakeCount() -> Int {
        self.lock.withLock { self.makeCount }
    }

    func latestTask() -> FakeGatewayWebSocketTask? {
        self.lock.withLock { self.tasks.last }
    }

    func latestRequest() -> URLRequest? {
        self.lock.withLock { self.requests.last }
    }

    func makeWebSocketTask(url: URL) -> WebSocketTaskBox {
        self.makeWebSocketTask(request: URLRequest(url: url))
    }

    func makeWebSocketTask(request: URLRequest) -> WebSocketTaskBox {
        self.lock.withLock {
            self.makeCount += 1
            self.requests.append(request)
            let task = FakeGatewayWebSocketTask(
                helloAuth: self.helloAuth,
                helloMethods: self.helloMethods,
                helloSessionDefaults: self.helloSessionDefaults,
                helloDelayNanoseconds: self.helloDelayNanoseconds,
                connectError: self.connectError,
                cancelGate: self.cancelGate)
            self.tasks.append(task)
            return WebSocketTaskBox(task: task)
        }
    }
}

private final class MutableHeaderValue: @unchecked Sendable {
    private let lock = NSLock()
    private var value: String
    private var reads = 0

    init(value: String) {
        self.value = value
    }

    func get() -> String {
        self.lock.withLock {
            self.reads += 1
            return self.value
        }
    }

    func set(_ value: String) {
        self.lock.withLock { self.value = value }
    }

    func readCount() -> Int {
        self.lock.withLock { self.reads }
    }
}

private actor SeqGapProbe {
    private var saw = false
    func mark() {
        self.saw = true
    }

    func value() -> Bool {
        self.saw
    }
}

private actor DisconnectProbe {
    private var reasons: [String] = []

    func record(_ reason: String) {
        self.reasons.append(reason)
    }

    func values() -> [String] {
        self.reasons
    }
}

private actor AsyncGate {
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

private actor ComputerInvokeProbe {
    private var invocationCount = 0
    private var released = false
    private var releaseWaiters: [CheckedContinuation<Void, Never>] = []

    func execute(_ request: BridgeInvokeRequest) async -> BridgeInvokeResponse {
        self.invocationCount += 1
        await withCheckedContinuation { continuation in
            if self.released {
                continuation.resume()
            } else {
                self.releaseWaiters.append(continuation)
            }
        }
        return BridgeInvokeResponse(
            id: request.id,
            ok: true,
            payloadJSON: #"{"acted":true}"#)
    }

    func count() -> Int {
        self.invocationCount
    }

    func release() {
        self.released = true
        let waiters = self.releaseWaiters
        self.releaseWaiters.removeAll()
        for waiter in waiters {
            waiter.resume()
        }
    }
}

private func nodeInvokePush(id: String, command: String) -> GatewayPush {
    .event(EventFrame(
        type: "event",
        event: "node.invoke.request",
        payload: AnyCodable([
            "id": AnyCodable(id),
            "nodeId": AnyCodable("test-node"),
            "command": AnyCodable(command),
            "paramsJSON": AnyCodable("{}"),
        ]),
        seq: nil,
        stateversion: nil))
}

@Suite(.serialized)
struct GatewayNodeSessionTests {
    @Test func `node connections use the node protocol floor`() {
        #expect(
            GatewayChannelActor.minimumProtocolVersion(role: "node", clientMode: "node") ==
                GATEWAY_MIN_NODE_PROTOCOL_VERSION)
        #expect(
            GatewayChannelActor.minimumProtocolVersion(role: "operator", clientMode: "ui") ==
                GATEWAY_MIN_PROTOCOL_VERSION)
    }

    @Test
    func `watch approval warning text is optional and round trips`() throws {
        let legacy = try JSONDecoder().decode(
            OpenClawWatchExecApprovalItem.self,
            from: Data(#"{"id":"approval","commandText":"echo ok","allowedDecisions":["deny"]}"#.utf8))
        #expect(legacy.warningText == nil)

        var current = legacy
        current.warningText = "Review shell expansion"
        let decoded = try JSONDecoder().decode(
            OpenClawWatchExecApprovalItem.self,
            from: JSONEncoder().encode(current))
        #expect(decoded.warningText == "Review shell expansion")
    }

    @Test
    func `watch approval recovery schema carries exact resolution attempt identifiers`() throws {
        let resetAttemptID = "\u{0085}reset-attempt\u{0085}"
        let prompt = OpenClawWatchExecApprovalPromptMessage(
            approval: OpenClawWatchExecApprovalItem(
                id: "approval",
                commandText: "echo ok"),
            resetResolutionAttemptId: resetAttemptID)
        let promptData = try JSONEncoder().encode(prompt)
        let promptObject = try #require(
            JSONSerialization.jsonObject(with: promptData) as? [String: Any])
        #expect(try Array(#require(promptObject["resetResolutionAttemptId"] as? String).utf8) ==
            Array(resetAttemptID.utf8))
        #expect(promptObject["deliveryId"] == nil)
        #expect(promptObject["resetResolvingState"] == nil)

        let approvalID = "\u{0085}held-approval\u{0085}"
        let activeAttemptID = "\u{0085}active-attempt\u{0085}"
        let request = OpenClawWatchExecApprovalSnapshotRequestMessage(
            requestId: "request",
            heldApprovals: [OpenClawWatchExecApprovalSnapshotRequestItem(
                approvalId: approvalID,
                activeResolutionAttemptId: activeAttemptID)])
        let decoded = try JSONDecoder().decode(
            OpenClawWatchExecApprovalSnapshotRequestMessage.self,
            from: JSONEncoder().encode(request))
        #expect(decoded.heldApprovals.count == 1)
        #expect(Array(decoded.heldApprovals[0].approvalId.utf8) == Array(approvalID.utf8))
        #expect(try Array(#require(decoded.heldApprovals[0].activeResolutionAttemptId).utf8) ==
            Array(activeAttemptID.utf8))
    }

    @Test
    func `websocket ping ignores duplicate success callbacks`() async throws {
        let task = DoubleCallbackPingWebSocketTask(callbacks: [nil, nil])
        try await WebSocketTaskBox(task: task).sendPing()
    }

    @Test
    func `websocket ping ignores duplicate callbacks after first error`() async throws {
        let firstError = URLError(.networkConnectionLost)
        let task = DoubleCallbackPingWebSocketTask(callbacks: [firstError, nil])

        do {
            try await WebSocketTaskBox(task: task).sendPing()
            Issue.record("sendPing unexpectedly succeeded")
        } catch let error as URLError {
            #expect(error.code == firstError.code)
        }
    }

    @Test
    func `route invalidation follows the replaced channel owner`() async throws {
        let session = FakeGatewayWebSocketSession()
        let gateway = GatewayNodeSession()
        let disconnects = DisconnectProbe()
        let invalidations = DisconnectProbe()
        let options = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "openclaw-ios-test",
            clientMode: "node",
            clientDisplayName: "iOS Test",
            includeDeviceIdentity: false)

        try await gateway.connect(
            url: #require(URL(string: "ws://first.example.invalid")),
            credentials: .init(),
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: session),
            onConnected: {},
            onDisconnected: { reason in await disconnects.record("first:\(reason)") },
            onInvoke: { req in BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil) },
            onRouteInvalidated: { await invalidations.record("first") })
        try await gateway.connect(
            url: #require(URL(string: "ws://first.example.invalid")),
            token: nil,
            bootstrapToken: nil,
            password: nil,
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: session),
            onConnected: {},
            onDisconnected: { reason in await disconnects.record("same:\(reason)") },
            onInvoke: { req in BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil) },
            onRouteInvalidated: { await invalidations.record("same") })
        #expect(await (invalidations.values()).isEmpty)
        try await gateway.connect(
            url: #require(URL(string: "ws://second.example.invalid")),
            credentials: .init(),
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: session),
            onConnected: {},
            onDisconnected: { reason in await disconnects.record("second:\(reason)") },
            onInvoke: { req in BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil) },
            onRouteInvalidated: { await invalidations.record("second") })

        for _ in 0..<20 {
            await Task.yield()
        }
        let replacementDisconnects = await disconnects.values()
        #expect(replacementDisconnects.isEmpty)
        #expect(await invalidations.values() == ["same"])

        await gateway.disconnect()
        for _ in 0..<20 {
            await Task.yield()
        }
        let finalDisconnects = await disconnects.values()
        #expect(finalDisconnects.isEmpty)
        #expect(await invalidations.values() == ["same", "second"])
    }

    @Test
    func `connect joins the snapshot dispatched connected callback`() async throws {
        let session = FakeGatewayWebSocketSession()
        let gateway = GatewayNodeSession()
        let connectedGate = AsyncGate()
        let lifecycle = DisconnectProbe()
        let options = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "openclaw-ios-test",
            clientMode: "node",
            clientDisplayName: "iOS Test",
            includeDeviceIdentity: false)

        let connect = Task {
            try await gateway.connect(
                url: #require(URL(string: "ws://first.example.invalid")),
                token: nil,
                bootstrapToken: nil,
                password: nil,
                connectOptions: options,
                sessionBox: WebSocketSessionBox(session: session),
                onConnected: {
                    await lifecycle.record("connected-start")
                    await connectedGate.wait()
                    await lifecycle.record("connected-end")
                },
                onDisconnected: { _ in },
                onInvoke: { req in
                    BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil)
                })
            await lifecycle.record("connect-returned")
        }
        defer { connect.cancel() }

        try await waitUntil("connected callback suspended") {
            await connectedGate.hasStarted()
        }
        for _ in 0..<20 {
            await Task.yield()
        }
        #expect(await lifecycle.values() == ["connected-start"])

        await connectedGate.release()
        try await connect.value
        #expect(await lifecycle.values() == [
            "connected-start",
            "connected-end",
            "connect-returned",
        ])
        await gateway.disconnect()
    }

    @Test
    func `concurrent replacements wait for route invalidation before installing a channel`() async throws {
        let session = FakeGatewayWebSocketSession()
        let gateway = GatewayNodeSession()
        let invalidationGate = AsyncGate()
        let options = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "openclaw-ios-test",
            clientMode: "node",
            clientDisplayName: "iOS Test",
            includeDeviceIdentity: false)

        try await gateway.connect(
            url: #require(URL(string: "ws://first.example.invalid")),
            token: nil,
            bootstrapToken: nil,
            password: nil,
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: session),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { req in BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil) },
            onRouteInvalidated: { await invalidationGate.wait() })

        let supersededReplacement = Task {
            try await gateway.connect(
                url: #require(URL(string: "ws://second.example.invalid")),
                token: nil,
                bootstrapToken: nil,
                password: nil,
                connectOptions: options,
                sessionBox: WebSocketSessionBox(session: session),
                onConnected: {},
                onDisconnected: { _ in },
                onInvoke: { req in
                    BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil)
                })
        }
        try await waitUntil("route invalidation started") {
            await invalidationGate.hasStarted()
        }
        let supersededAdmissionGeneration = await gateway._test_admissionGeneration()
        let finalReplacement = Task {
            try await gateway.connect(
                url: #require(URL(string: "ws://third.example.invalid")),
                token: nil,
                bootstrapToken: nil,
                password: nil,
                connectOptions: options,
                sessionBox: WebSocketSessionBox(session: session),
                onConnected: {},
                onDisconnected: { _ in },
                onInvoke: { req in
                    BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil)
                })
        }
        try await waitUntil("final replacement revoked superseded admission") {
            await gateway._test_admissionGeneration() != supersededAdmissionGeneration
        }

        #expect(await gateway.currentRoute() == nil)
        #expect(session.snapshotMakeCount() == 1)

        await invalidationGate.release()
        do {
            try await supersededReplacement.value
            Issue.record("superseded replacement unexpectedly connected")
        } catch is CancellationError {
            // Expected: the final replacement advanced the generation while teardown waited.
        }
        try await finalReplacement.value
        #expect(await gateway.currentRoute() != nil)
        #expect(session.snapshotMakeCount() == 2)
        await gateway.disconnect()
    }

    @Test
    func `stale old invoke is rejected before onInvoke after route switch`() async throws {
        let session = FakeGatewayWebSocketSession()
        let gateway = GatewayNodeSession()
        let invocations = DisconnectProbe()
        let options = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: ["computer"],
            commands: ["computer.act"],
            permissions: [:],
            clientId: "openclaw-macos",
            clientMode: "node",
            clientDisplayName: "macOS Test",
            includeDeviceIdentity: false)

        try await gateway.connect(
            url: #require(URL(string: "ws://first.example.invalid")),
            token: nil,
            bootstrapToken: nil,
            password: nil,
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: session),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { req in BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil) })
        let oldRoute = try #require(await gateway.currentRoute())

        try await gateway.connect(
            url: #require(URL(string: "ws://replacement.example.invalid")),
            token: nil,
            bootstrapToken: nil,
            password: nil,
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: session),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { req in BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil) })

        let response = await gateway.invokeIfCurrentRoute(
            BridgeInvokeRequest(id: "stale-computer", command: "computer.act", paramsJSON: "{}"),
            expectedRoute: oldRoute,
            onInvoke: { request in
                await invocations.record(request.id)
                return BridgeInvokeResponse(id: request.id, ok: true, payloadJSON: nil, error: nil)
            })

        #expect(response.ok == false)
        #expect(response.error?.code == .unavailable)
        #expect(await invocations.values() == [])
        await gateway.disconnect()
    }

    @Test
    func `socket disconnect cancels a decoded invoke before delayed native admission`() async throws {
        let session = FakeGatewayWebSocketSession()
        let gateway = GatewayNodeSession()
        let invokeStarted = AsyncGate()
        let allowAdmission = AsyncGate()
        let invocations = DisconnectProbe()
        let disconnects = DisconnectProbe()
        let options = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: ["computer"],
            commands: ["computer.act"],
            permissions: [:],
            clientId: "openclaw-macos",
            clientMode: "node",
            clientDisplayName: "macOS Test",
            includeDeviceIdentity: false)

        try await gateway.connect(
            url: #require(URL(string: "ws://first.example.invalid")),
            token: nil,
            bootstrapToken: nil,
            password: nil,
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: session),
            onConnected: {},
            onDisconnected: { reason in await disconnects.record(reason) },
            onInvoke: { request in
                await invokeStarted.wait()
                await allowAdmission.wait()
                guard !Task.isCancelled else {
                    return BridgeInvokeResponse(
                        id: request.id,
                        ok: false,
                        error: OpenClawNodeError(
                            code: .unavailable,
                            message: "UNAVAILABLE: canceled before native admission"))
                }
                await invocations.record(request.id)
                return BridgeInvokeResponse(id: request.id, ok: true, payloadJSON: nil, error: nil)
            })
        let firstTask = try #require(session.latestTask())
        try await waitUntil("receive loop armed before delayed invoke") {
            firstTask.hasPendingReceiveHandler()
        }
        firstTask.emitInvokeRequest(id: "stale-computer", command: "computer.act")
        try await waitUntil("delayed invoke started") {
            await invokeStarted.hasStarted()
        }
        await invokeStarted.release()
        try await waitUntil("receive loop rearmed before disconnect") {
            firstTask.hasPendingReceiveHandler()
        }

        firstTask.emitReceiveFailure()
        try await waitUntil("disconnect callback ran") {
            await !(disconnects.values()).isEmpty
        }
        await allowAdmission.release()
        try await waitUntil("replacement socket created") {
            session.snapshotMakeCount() >= 2
        }

        #expect(await invocations.values() == [])
        #expect(firstTask.sentRequestCount(method: "node.invoke.result") == 0)
        await gateway.disconnect()
    }

    @Test
    func `route switch cancels an in flight push to talk start`() async throws {
        let session = FakeGatewayWebSocketSession()
        let gateway = GatewayNodeSession()
        let invokeStarted = AsyncGate()
        let cancellations = DisconnectProbe()
        let options = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: ["talk"],
            commands: ["talk.ptt.start"],
            permissions: [:],
            clientId: "openclaw-ios",
            clientMode: "node",
            clientDisplayName: "iOS Test",
            includeDeviceIdentity: false)

        try await gateway.connect(
            url: #require(URL(string: "ws://first.example.invalid")),
            token: nil,
            bootstrapToken: nil,
            password: nil,
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: session),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { req in BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil) })
        let route = try #require(await gateway.currentRoute())
        let invoking = Task {
            await gateway.invokeIfCurrentRoute(
                BridgeInvokeRequest(id: "stale-ptt", command: "talk.ptt.start", paramsJSON: nil),
                expectedRoute: route,
                onInvoke: { request in
                    await invokeStarted.wait()
                    do {
                        try await Task.sleep(nanoseconds: 60 * 1_000_000_000)
                    } catch {
                        await cancellations.record(request.id)
                    }
                    return BridgeInvokeResponse(
                        id: request.id,
                        ok: false,
                        error: OpenClawNodeError(code: .unavailable, message: "UNAVAILABLE: route changed"))
                })
        }
        try await waitUntil("push to talk invoke started") {
            await invokeStarted.hasStarted()
        }
        await invokeStarted.release()

        try await gateway.connect(
            url: #require(URL(string: "ws://replacement.example.invalid")),
            token: nil,
            bootstrapToken: nil,
            password: nil,
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: session),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { req in BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil) })

        #expect(await (invoking.value).ok == false)
        #expect(await cancellations.values() == ["stale-ptt"])
        await gateway.disconnect()
    }

    @Test
    func `queued old socket invoke cannot adopt replacement admission after disconnect cleanup`() async throws {
        let session = FakeGatewayWebSocketSession()
        let gateway = GatewayNodeSession()
        let invocations = DisconnectProbe()
        let options = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: ["computer"],
            commands: ["computer.act"],
            permissions: [:],
            clientId: "openclaw-macos",
            clientMode: "node",
            clientDisplayName: "macOS Test",
            includeDeviceIdentity: false)

        try await gateway.connect(
            url: #require(URL(string: "ws://first.example.invalid")),
            token: nil,
            bootstrapToken: nil,
            password: nil,
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: session),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { request in
                await invocations.record(request.id)
                return BridgeInvokeResponse(id: request.id, ok: true, payloadJSON: nil, error: nil)
            })

        // Model an old push callback that was already queued on the session actor:
        // cleanup retires socket 1, then socket 2 becomes the active route before it runs.
        await gateway._test_handleChannelDisconnected("socket 1 lost", socketGeneration: 1)
        await gateway._test_handlePush(
            .event(EventFrame(
                type: "event",
                event: "tick",
                payload: nil,
                seq: nil,
                stateversion: nil)),
            socketGeneration: 2)
        await gateway._test_handlePush(
            nodeInvokePush(id: "queued-old-computer", command: "computer.act"),
            socketGeneration: 1)
        await gateway._test_handlePush(
            nodeInvokePush(id: "replacement-computer", command: "computer.act"),
            socketGeneration: 2)

        try await waitUntil("replacement invoke executed") {
            await invocations.values() == ["replacement-computer"]
        }
        #expect(await invocations.values() == ["replacement-computer"])
        await gateway.disconnect()
    }

    @Test
    func `stale connect completion cannot notify after admission changes`() async throws {
        let session = FakeGatewayWebSocketSession()
        let gateway = GatewayNodeSession()
        let lifecycle = DisconnectProbe()
        let options = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: ["computer"],
            commands: ["computer.act"],
            permissions: [:],
            clientId: "openclaw-macos",
            clientMode: "node",
            clientDisplayName: "macOS Test",
            includeDeviceIdentity: false)

        try await gateway.connect(
            url: #require(URL(string: "ws://first.example.invalid")),
            token: nil,
            bootstrapToken: nil,
            password: nil,
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: session),
            onConnected: { await lifecycle.record("connected") },
            onDisconnected: { _ in await lifecycle.record("disconnected") },
            onInvoke: { req in BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil) })
        try await waitUntil("initial connected callback completed") {
            await lifecycle.values() == ["connected"]
        }
        let staleAdmissionGeneration = await gateway._test_admissionGeneration()

        await gateway._test_handleChannelDisconnected("socket lost", socketGeneration: 1)
        await gateway._test_notifyConnectedIfNeeded(
            admissionGeneration: staleAdmissionGeneration)

        try await waitUntil("disconnect callback completed") {
            await lifecycle.values().contains("disconnected")
        }
        #expect(await lifecycle.values() == ["connected", "disconnected"])
        await gateway.disconnect()
    }

    @Test
    func `transport reconnect does not wait for blocked disconnect lifecycle`() async throws {
        let session = FakeGatewayWebSocketSession()
        let gateway = GatewayNodeSession()
        let invalidationGate = AsyncGate()
        let lifecycle = DisconnectProbe()
        let options = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: ["computer"],
            commands: ["computer.act"],
            permissions: [:],
            clientId: "openclaw-macos",
            clientMode: "node",
            clientDisplayName: "macOS Test",
            includeDeviceIdentity: false)

        try await gateway.connect(
            url: #require(URL(string: "ws://first.example.invalid")),
            token: nil,
            bootstrapToken: nil,
            password: nil,
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: session),
            onConnected: { await lifecycle.record("connected") },
            onDisconnected: { _ in await lifecycle.record("disconnected") },
            onInvoke: { req in
                BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil)
            },
            onRouteInvalidated: { await invalidationGate.wait() })
        let firstTask = try #require(session.latestTask())
        try await waitUntil("receive loop armed before disconnect") {
            firstTask.hasPendingReceiveHandler()
        }

        firstTask.emitReceiveFailure()
        try await waitUntil("disconnect lifecycle blocked") {
            await invalidationGate.hasStarted()
        }
        try await waitUntil("replacement transport connected") {
            session.snapshotMakeCount() == 2
        }
        #expect(await lifecycle.values() == ["connected"])

        await invalidationGate.release()
        try await waitUntil("replacement lifecycle completed") {
            await lifecycle.values() == ["connected", "disconnected", "connected"]
        }
        await gateway.disconnect()
    }

    @Test
    func `replacement invoke fails promptly while disconnect lifecycle is blocked`() async throws {
        let session = FakeGatewayWebSocketSession()
        let gateway = GatewayNodeSession()
        let invalidationGate = AsyncGate()
        let invocations = DisconnectProbe()
        let options = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: [],
            commands: ["system.which"],
            permissions: [:],
            clientId: "openclaw-macos",
            clientMode: "node",
            clientDisplayName: "macOS Test",
            includeDeviceIdentity: false)

        try await gateway.connect(
            url: #require(URL(string: "ws://first.example.invalid")),
            token: nil,
            bootstrapToken: nil,
            password: nil,
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: session),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { request in
                await invocations.record(request.id)
                return BridgeInvokeResponse(id: request.id, ok: true, payloadJSON: nil, error: nil)
            },
            onRouteInvalidated: { await invalidationGate.wait() })
        let firstTask = try #require(session.latestTask())
        try await waitUntil("receive loop armed before disconnect") {
            firstTask.hasPendingReceiveHandler()
        }

        firstTask.emitReceiveFailure()
        try await waitUntil("disconnect lifecycle blocked") {
            await invalidationGate.hasStarted()
        }
        try await waitUntil("replacement transport connected") {
            session.snapshotMakeCount() == 2
        }
        let replacementTask = try #require(session.latestTask())
        try await waitUntil("replacement socket receiving") {
            replacementTask.hasPendingReceiveHandler()
        }
        replacementTask.emitInvokeRequest(id: "during-lifecycle", command: "system.which")

        try await waitUntil("lifecycle unavailable result") {
            replacementTask.sentRequestCount(method: "node.invoke.result") == 1
        }
        let result = try #require(replacementTask.sentRequests(method: "node.invoke.result").first)
        let params = try #require(result["params"] as? [String: Any])
        let error = try #require(params["error"] as? [String: Any])
        #expect(params["id"] as? String == "during-lifecycle")
        #expect(params["ok"] as? Bool == false)
        #expect(error["code"] as? String == OpenClawNodeErrorCode.unavailable.rawValue)
        #expect(error["message"] as? String == "UNAVAILABLE: node lifecycle transition in progress")
        #expect(await invocations.values() == [])

        await invalidationGate.release()
        await gateway.disconnect()
    }

    @Test
    func `disconnect cleanup finishes after an in flight connected callback`() async throws {
        let session = FakeGatewayWebSocketSession()
        let gateway = GatewayNodeSession()
        let connectedGate = AsyncGate()
        let lifecycle = DisconnectProbe()
        let options = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: ["computer"],
            commands: ["computer.act"],
            permissions: [:],
            clientId: "openclaw-macos",
            clientMode: "node",
            clientDisplayName: "macOS Test",
            includeDeviceIdentity: false)

        let connect = Task {
            try await gateway.connect(
                url: #require(URL(string: "ws://first.example.invalid")),
                token: nil,
                bootstrapToken: nil,
                password: nil,
                connectOptions: options,
                sessionBox: WebSocketSessionBox(session: session),
                onConnected: {
                    await lifecycle.record("connected-start")
                    await connectedGate.wait()
                    await lifecycle.record("connected-end")
                },
                onDisconnected: { _ in await lifecycle.record("disconnected") },
                onInvoke: { req in
                    BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil)
                },
                onRouteInvalidated: { await lifecycle.record("invalidated") })
        }
        try await waitUntil("connected callback suspended") {
            await connectedGate.hasStarted()
        }
        let firstTask = try #require(session.latestTask())
        try await waitUntil("receive loop armed before disconnect") {
            firstTask.hasPendingReceiveHandler()
        }

        firstTask.emitReceiveFailure()
        try await waitUntil("route invalidated before connected callback returned") {
            await lifecycle.values().contains("invalidated")
        }
        let invalidatedLifecycle = await lifecycle.values()
        #expect(!invalidatedLifecycle.contains("disconnected"))

        await connectedGate.release()
        _ = try? await connect.value
        try await waitUntil("disconnect cleanup completed") {
            await lifecycle.values().contains("disconnected")
        }
        let completedLifecycle = await lifecycle.values()
        let orderedLifecycle = Array(completedLifecycle.prefix(4))
        #expect(orderedLifecycle == [
            "connected-start",
            "invalidated",
            "connected-end",
            "disconnected",
        ])
        await gateway.disconnect()
    }

    @Test
    func `connected callback can disconnect its own route without deadlock`() async throws {
        let session = FakeGatewayWebSocketSession()
        let gateway = GatewayNodeSession()
        let lifecycle = DisconnectProbe()
        let connectedExitGate = AsyncGate()
        let options = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: ["computer"],
            commands: ["computer.act"],
            permissions: [:],
            clientId: "openclaw-macos",
            clientMode: "node",
            clientDisplayName: "macOS Test",
            includeDeviceIdentity: false)

        let connect = Task {
            try? await gateway.connect(
                url: #require(URL(string: "ws://first.example.invalid")),
                token: nil,
                bootstrapToken: nil,
                password: nil,
                connectOptions: options,
                sessionBox: WebSocketSessionBox(session: session),
                onConnected: {
                    await lifecycle.record("connected-start")
                    await gateway.disconnect()
                    await lifecycle.record("disconnect-returned")
                    await connectedExitGate.wait()
                    await lifecycle.record("connected-end")
                },
                onDisconnected: { _ in await lifecycle.record("disconnected") },
                onInvoke: { req in
                    BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil)
                },
                onRouteInvalidated: { await lifecycle.record("invalidated") })
        }
        defer { connect.cancel() }

        try await waitUntil("reentrant disconnect returned to connected callback") {
            await lifecycle.values().contains("disconnect-returned")
        }

        let replacement = Task {
            try await gateway.connect(
                url: #require(URL(string: "ws://second.example.invalid")),
                token: nil,
                bootstrapToken: nil,
                password: nil,
                connectOptions: options,
                sessionBox: WebSocketSessionBox(session: session),
                onConnected: {},
                onDisconnected: { _ in },
                onInvoke: { req in
                    BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil)
                },
                onRouteInvalidated: {})
        }
        defer { replacement.cancel() }
        for _ in 0..<20 {
            await Task.yield()
        }
        #expect(session.snapshotMakeCount() == 1)
        #expect(await gateway.currentRoute() == nil)

        await connectedExitGate.release()
        _ = await connect.value
        try await replacement.value

        #expect(await gateway.currentRoute() != nil)
        #expect(session.snapshotMakeCount() == 2)
        let values = await lifecycle.values()
        #expect(values.first == "connected-start")
        #expect(values.contains("invalidated"))
        #expect(values.contains("connected-end"))
        await gateway.disconnect()
    }

    @Test
    func `route invalidation callback can disconnect without awaiting its own teardown`() async throws {
        let session = FakeGatewayWebSocketSession()
        let gateway = GatewayNodeSession()
        let lifecycle = DisconnectProbe()
        let options = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: ["computer"],
            commands: ["computer.act"],
            permissions: [:],
            clientId: "openclaw-macos",
            clientMode: "node",
            clientDisplayName: "macOS Test",
            includeDeviceIdentity: false)

        try await gateway.connect(
            url: #require(URL(string: "ws://first.example.invalid")),
            token: nil,
            bootstrapToken: nil,
            password: nil,
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: session),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { req in
                BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil)
            },
            onRouteInvalidated: {
                await lifecycle.record("invalidation-start")
                await gateway.disconnect()
                await lifecycle.record("invalidation-end")
            })

        await gateway.disconnect()
        let values = await lifecycle.values()
        #expect(values.first == "invalidation-start")
        #expect(values.last == "invalidation-end")
        #expect(values.filter { $0 == "invalidation-start" }.count ==
            values.filter { $0 == "invalidation-end" }.count)
        #expect(await gateway.currentRoute() == nil)
    }

    @Test
    func `socket loss releases connected callback pending request before disconnect cleanup`() async throws {
        let session = FakeGatewayWebSocketSession()
        let gateway = GatewayNodeSession()
        let lifecycle = DisconnectProbe()
        let options = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "openclaw-ios-test",
            clientMode: "node",
            clientDisplayName: "iOS Test",
            includeDeviceIdentity: false)

        let connect = Task {
            try? await gateway.connect(
                url: #require(URL(string: "ws://first.example.invalid")),
                token: nil,
                bootstrapToken: nil,
                password: nil,
                connectOptions: options,
                sessionBox: WebSocketSessionBox(session: session),
                onConnected: {
                    do {
                        _ = try await gateway.request(
                            method: "node.test.pending",
                            paramsJSON: nil,
                            timeoutSeconds: 0)
                    } catch {
                        await lifecycle.record("request-failed")
                    }
                },
                onDisconnected: { _ in await lifecycle.record("disconnected") },
                onInvoke: { req in
                    BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil)
                })
        }
        defer { connect.cancel() }

        try await waitUntil("connected callback issued pending request") {
            session.latestTask()?.sentRequestCount(method: "node.test.pending") == 1
        }
        let firstTask = try #require(session.latestTask())
        try await waitUntil("receive loop armed before pending request disconnect") {
            firstTask.hasPendingReceiveHandler()
        }
        firstTask.emitReceiveFailure()

        try await waitUntil("pending request and disconnect lifecycle both completed") {
            await lifecycle.values().contains("disconnected")
        }
        _ = await connect.value
        #expect(await lifecycle.values().prefix(2) == ["request-failed", "disconnected"])
        await gateway.disconnect()
    }

    @Test
    func `detached channel cannot reconnect while route invalidation is suspended`() async throws {
        let session = FakeGatewayWebSocketSession()
        let gateway = GatewayNodeSession()
        let invalidationGate = AsyncGate()
        let options = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: ["computer"],
            commands: ["computer.act"],
            permissions: [:],
            clientId: "openclaw-macos",
            clientMode: "node",
            clientDisplayName: "macOS Test",
            includeDeviceIdentity: false)

        try await gateway.connect(
            url: #require(URL(string: "ws://first.example.invalid")),
            token: nil,
            bootstrapToken: nil,
            password: nil,
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: session),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { req in
                BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil)
            },
            onRouteInvalidated: { await invalidationGate.wait() })
        let firstTask = try #require(session.latestTask())

        let replacement = Task {
            try await gateway.connect(
                url: #require(URL(string: "ws://second.example.invalid")),
                token: nil,
                bootstrapToken: nil,
                password: nil,
                connectOptions: options,
                sessionBox: WebSocketSessionBox(session: session),
                onConnected: {},
                onDisconnected: { _ in },
                onInvoke: { req in
                    BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil)
                },
                onRouteInvalidated: {})
        }
        defer { replacement.cancel() }
        try await waitUntil("route invalidation suspended replacement") {
            await invalidationGate.hasStarted()
        }

        firstTask.emitReceiveFailure()
        try await Task.sleep(for: .milliseconds(650))
        #expect(session.snapshotMakeCount() == 1)

        await invalidationGate.release()
        try await replacement.value
        #expect(session.snapshotMakeCount() == 2)
        await gateway.disconnect()
    }

    @Test
    func `upgrade request carries sanitized custom headers read per connect`() async throws {
        let session = FakeGatewayWebSocketSession()
        let gateway = GatewayNodeSession()
        let secret = MutableHeaderValue(value: "first-secret")
        let options = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "openclaw-ios-test",
            clientMode: "node",
            clientDisplayName: "iOS Test",
            includeDeviceIdentity: false)
        let url = try #require(URL(string: "wss://gateway.example.invalid"))
        let provider: @Sendable () -> [String: String] = {
            [
                "CF-Access-Client-Id": "client-id",
                "CF-Access-Client-Secret": secret.get(),
                "Host": "smuggled.example.invalid",
            ]
        }
        let connectOnce: () async throws -> Void = {
            try await gateway.connect(
                url: url,
                credentials: .init(),
                connectOptions: options,
                sessionBox: WebSocketSessionBox(session: session),
                extraHeadersProvider: provider,
                onConnected: {},
                onDisconnected: { _ in },
                onInvoke: { req in
                    BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil)
                })
        }

        try await connectOnce()
        let request = try #require(session.latestRequest())
        #expect(request.url == url)
        #expect(request.value(forHTTPHeaderField: "CF-Access-Client-Id") == "client-id")
        #expect(request.value(forHTTPHeaderField: "CF-Access-Client-Secret") == "first-secret")
        #expect(request.value(forHTTPHeaderField: "Host") == nil)

        // Header edits must ride the next upgrade without re-pairing or a new channel identity.
        secret.set("second-secret")
        await gateway.disconnect()
        try await connectOnce()
        let reconnectRequest = try #require(session.latestRequest())
        #expect(reconnectRequest.value(forHTTPHeaderField: "CF-Access-Client-Secret") == "second-secret")

        await gateway.disconnect()
    }

    @Test
    func `cleartext upgrade never reads or attaches custom headers`() async throws {
        let session = FakeGatewayWebSocketSession()
        let gateway = GatewayNodeSession()
        let secret = MutableHeaderValue(value: "must-not-be-read")
        let options = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "openclaw-ios-test",
            clientMode: "node",
            clientDisplayName: "iOS Test",
            includeDeviceIdentity: false)

        try await gateway.connect(
            url: #require(URL(string: "ws://gateway.example.invalid")),
            credentials: .init(),
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: session),
            extraHeadersProvider: { [secret] in ["Authorization": secret.get()] },
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { req in
                BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil)
            })

        let request = try #require(session.latestRequest())
        #expect(secret.readCount() == 0)
        #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
        await gateway.disconnect()
    }

    @Test
    func `server methods stay bound to the connected route`() async throws {
        let session = FakeGatewayWebSocketSession(helloMethods: [
            "approval.get",
            "approval.resolve",
            "exec.approval.get",
            "exec.approval.resolve",
        ])
        let gateway = GatewayNodeSession()
        let options = GatewayConnectOptions(
            role: "operator",
            scopes: [],
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "openclaw-ios-test",
            clientMode: "operator",
            clientDisplayName: "iOS Test",
            includeDeviceIdentity: false)

        try await gateway.connect(
            url: #require(URL(string: "ws://gateway.example.invalid")),
            token: nil,
            bootstrapToken: nil,
            password: nil,
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: session),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { req in BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil) })
        let route = try #require(await gateway.currentRoute())
        #expect(await gateway.supportsServerMethod("approval.get", ifCurrentRoute: route) == true)
        #expect(await gateway.supportsServerMethod("missing", ifCurrentRoute: route) == false)

        await gateway.disconnect()
        #expect(await gateway.supportsServerMethod("approval.get", ifCurrentRoute: route) == nil)
    }

    @Test
    func `captured route bound operations never use a replacement channel`() async throws {
        let session = FakeGatewayWebSocketSession()
        let gateway = GatewayNodeSession()
        let composedGatewayID = "gw-\u{00E9}"
        let decomposedGatewayID = "gw-e\u{0301}"
        let options = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "openclaw-ios-test",
            clientMode: "node",
            clientDisplayName: "iOS Test",
            includeDeviceIdentity: false,
            deviceAuthGatewayID: composedGatewayID)

        try await gateway.connect(
            url: #require(URL(string: "ws://first.example.invalid")),
            credentials: .init(),
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: session),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { req in BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil) })
        let firstRoute = try #require(await gateway.currentRoute(ifGatewayID: composedGatewayID))
        #expect(composedGatewayID == decomposedGatewayID)
        #expect(await gateway.currentRoute(ifGatewayID: decomposedGatewayID) == nil)
        let capturedFirstRouteSender: @Sendable (String, String?) async -> Bool = { event, payloadJSON in
            await gateway.sendEvent(
                event: event,
                payloadJSON: payloadJSON,
                ifCurrentRoute: firstRoute)
        }

        var replacementOptions = options
        replacementOptions.deviceAuthGatewayID = decomposedGatewayID
        try await gateway.connect(
            url: #require(URL(string: "ws://first.example.invalid")),
            credentials: .init(),
            connectOptions: replacementOptions,
            sessionBox: WebSocketSessionBox(session: session),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { req in BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil) })

        #expect(await gateway.currentRoute(ifGatewayID: composedGatewayID) == nil)
        #expect(await gateway.currentRoute(ifGatewayID: decomposedGatewayID) != nil)

        let sent = await capturedFirstRouteSender("push.apns.register", "{}")
        #expect(!sent)
        do {
            _ = try await gateway.request(
                method: "approval.get",
                paramsJSON: "{}",
                ifCurrentRoute: firstRoute)
            Issue.record("stale route request unexpectedly reached the replacement channel")
        } catch is CancellationError {
            // Expected: the route lease belongs to the first channel.
        }
        do {
            _ = try await gateway.request(
                method: "approval.get",
                paramsJSON: "{}",
                ifCurrentRoute: firstRoute,
                distinguishPreDispatchRouteChange: true)
            Issue.record("typed stale route request unexpectedly reached the replacement channel")
        } catch is GatewayNodeSessionRequestError {
            // Expected: callers can distinguish a request rejected before dispatch.
        }
        let replacementTask = try #require(session.latestTask())
        #expect(replacementTask.sentRequestCount(method: "node.event") == 0)
        #expect(replacementTask.sentRequestCount(method: "approval.get") == 0)
    }

    @Test
    func `disconnect during channel shutdown prevents stale channel install`() async throws {
        let cancelGate = FirstCancelGate()
        let session = FakeGatewayWebSocketSession(cancelGate: cancelGate)
        let gateway = GatewayNodeSession()
        let options = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "openclaw-ios-test",
            clientMode: "node",
            clientDisplayName: "iOS Test",
            includeDeviceIdentity: false)

        try await gateway.connect(
            url: #require(URL(string: "ws://first.example.invalid")),
            credentials: .init(token: "first-token"),
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: session),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { req in BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil) })

        let replacement = Task {
            try await gateway.connect(
                url: #require(URL(string: "ws://stale.example.invalid")),
                credentials: .init(token: "stale-token"),
                connectOptions: options,
                sessionBox: WebSocketSessionBox(session: session),
                onConnected: {},
                onDisconnected: { _ in },
                onInvoke: { req in
                    BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil)
                })
        }
        let deadline = ContinuousClock().now.advanced(by: .seconds(2))
        while !cancelGate.hasStarted(), ContinuousClock().now < deadline {
            await Task.yield()
        }
        #expect(cancelGate.hasStarted())
        #expect(await gateway.currentRoute() == nil)

        let release = Task.detached {
            try? await Task.sleep(nanoseconds: 10_000_000)
            cancelGate.release()
        }
        await gateway.disconnect()
        await release.value
        do {
            try await replacement.value
            Issue.record("superseded replacement unexpectedly connected")
        } catch is CancellationError {
            // Expected: disconnect advanced the generation while old-channel shutdown was suspended.
        }

        #expect(session.snapshotMakeCount() == 1)
    }

    @Test
    func `invoke result is discarded after target switch`() async throws {
        let session = FakeGatewayWebSocketSession()
        let gateway = GatewayNodeSession()
        let invokeStarted = AsyncStream<Void>.makeStream()
        let invokeRelease = AsyncStream<Void>.makeStream()
        var startedIterator = invokeStarted.stream.makeAsyncIterator()
        let options = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: [],
            commands: ["camera.snap"],
            permissions: [:],
            clientId: "openclaw-ios-test",
            clientMode: "node",
            clientDisplayName: "iOS Test",
            includeDeviceIdentity: false)

        try await gateway.connect(
            url: #require(URL(string: "ws://first.example.invalid")),
            credentials: .init(token: "first-token"),
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: session),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { request in
                invokeStarted.continuation.yield()
                for await _ in invokeRelease.stream {
                    return BridgeInvokeResponse(
                        id: request.id,
                        ok: true,
                        payloadJSON: #"{"sensitive":"camera-result"}"#,
                        error: nil)
                }
                return BridgeInvokeResponse(id: request.id, ok: false, payloadJSON: nil, error: nil)
            })
        let firstTask = try #require(session.latestTask())
        firstTask.emitInvokeRequest(id: "invoke-old", command: "camera.snap")
        _ = await startedIterator.next()

        try await gateway.connect(
            url: #require(URL(string: "ws://replacement.example.invalid")),
            credentials: .init(token: "replacement-token"),
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: session),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { req in BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil) })
        let replacementTask = try #require(session.latestTask())

        invokeRelease.continuation.yield()
        invokeRelease.continuation.finish()
        for _ in 0..<100 {
            await Task.yield()
        }

        #expect(firstTask.sentRequestCount(method: "node.invoke.result") == 0)
        #expect(replacementTask.sentRequestCount(method: "node.invoke.result") == 0)
        await gateway.disconnect()
    }

    @Test
    func `node invoke requests keep receiving while system run is blocked`() async throws {
        let session = FakeGatewayWebSocketSession()
        let gateway = GatewayNodeSession()
        let systemRunStarted = AsyncStream<Void>.makeStream()
        var startedIterator = systemRunStarted.stream.makeAsyncIterator()
        let systemRunRelease = AsyncStream<Void>.makeStream()
        let options = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: [],
            commands: ["system.run"],
            permissions: [:],
            clientId: "openclaw-macos",
            clientMode: "node",
            clientDisplayName: "macOS Test",
            includeDeviceIdentity: false)

        try await gateway.connect(
            url: #require(URL(string: "ws://example.invalid")),
            credentials: .init(),
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: session),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { request in
                if request.id == "system-run-blocked" {
                    systemRunStarted.continuation.yield()
                    for await _ in systemRunRelease.stream {
                        return BridgeInvokeResponse(
                            id: request.id,
                            ok: false,
                            error: OpenClawNodeError(
                                code: .unavailable,
                                message: "UNSUPPORTED: system.run unavailable"))
                    }
                }
                return BridgeInvokeResponse(id: request.id, ok: true, payloadJSON: #"{"ok":true}"#)
            })
        let task = try #require(session.latestTask())

        task.emitInvokeRequest(
            id: "system-run-blocked",
            command: "system.run",
            paramsJSON: #"{"command":["/bin/echo","ok"]}"#)
        _ = await startedIterator.next()
        try await waitUntil("receive loop rearmed during system.run") {
            task.hasPendingReceiveHandler()
        }
        task.emitInvokeRequest(id: "camera-after-system-run", command: "camera.snap")

        try await waitUntil("second invoke result while system.run is blocked") {
            task.sentRequestCount(method: "node.invoke.result") == 1
        }
        let earlyResults = task.sentRequests(method: "node.invoke.result")
        #expect(earlyResults.count == 1)
        let earlyParams = try #require(earlyResults.first?["params"] as? [String: Any])
        #expect(earlyParams["id"] as? String == "camera-after-system-run")
        #expect(earlyParams["ok"] as? Bool == true)

        systemRunRelease.continuation.yield()
        systemRunRelease.continuation.finish()
        try await waitUntil("blocked system.run result") {
            task.sentRequestCount(method: "node.invoke.result") == 2
        }
        let finalResults = task.sentRequests(method: "node.invoke.result")
        #expect(finalResults.count == 2)
        let blockedResult = try #require(finalResults.first {
            ($0["params"] as? [String: Any])?["id"] as? String == "system-run-blocked"
        })
        let blockedParams = try #require(blockedResult["params"] as? [String: Any])
        #expect(blockedParams["ok"] as? Bool == false)
        let error = try #require(blockedParams["error"] as? [String: Any])
        #expect(error["code"] as? String == OpenClawNodeErrorCode.unavailable.rawValue)

        await gateway.disconnect()
    }

    @Test
    func `node invoke result preserves structured worker payload`() async throws {
        let session = FakeGatewayWebSocketSession()
        let gateway = GatewayNodeSession()
        let options = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: ["mcp"],
            commands: ["mcp.tools.call.v1"],
            permissions: [:],
            clientId: "openclaw-macos",
            clientMode: "node",
            clientDisplayName: "macOS Test",
            includeDeviceIdentity: false)

        try await gateway.connect(
            url: #require(URL(string: "ws://example.invalid")),
            credentials: .init(),
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: session),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { request in
                BridgeInvokeResponse(
                    id: request.id,
                    ok: true,
                    payload: AnyCodable(["content": [["type": "text", "text": "worker-ok"]]]))
            })
        let task = try #require(session.latestTask())
        task.emitInvokeRequest(id: "mcp-structured", command: "mcp.tools.call.v1")

        try await waitUntil("structured invoke result") {
            task.sentRequestCount(method: "node.invoke.result") == 1
        }
        let result = try #require(task.sentRequests(method: "node.invoke.result").first)
        let params = try #require(result["params"] as? [String: Any])
        let payload = try #require(params["payload"] as? [String: Any])
        let content = try #require(payload["content"] as? [[String: Any]])
        #expect(content.first?["text"] as? String == "worker-ok")

        await gateway.disconnect()
    }

    @Test
    func `computer invoke receipts deduplicate in flight and after reconnect`() async throws {
        let session = FakeGatewayWebSocketSession()
        let gateway = GatewayNodeSession()
        let probe = ComputerInvokeProbe()
        let options = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: ["computer"],
            commands: ["computer.act"],
            permissions: [:],
            clientId: "openclaw-macos",
            clientMode: "node",
            clientDisplayName: "macOS Test",
            includeDeviceIdentity: false)

        try await gateway.connect(
            url: #require(URL(string: "ws://example.invalid")),
            token: nil,
            bootstrapToken: nil,
            password: nil,
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: session),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { request in await probe.execute(request) })
        let firstTask = try #require(session.latestTask())
        let idempotencyKey = "computer.act:v1:stable-call"
        let paramsJSON = #"{"action":"type","text":"hello","refWidth":1280}"#

        firstTask.emitInvokeRequest(
            id: "computer-first",
            command: "computer.act",
            paramsJSON: paramsJSON,
            idempotencyKey: idempotencyKey)
        try await waitUntil("first computer invoke started") {
            await probe.count() == 1
        }
        try await waitUntil("receive loop rearmed during computer invoke") {
            firstTask.hasPendingReceiveHandler()
        }
        firstTask.emitInvokeRequest(
            id: "computer-in-flight-replay",
            command: "computer.act",
            paramsJSON: paramsJSON,
            idempotencyKey: idempotencyKey)
        for _ in 0..<20 {
            await Task.yield()
        }
        #expect(await probe.count() == 1)

        await probe.release()
        try await waitUntil("both in-flight computer receipts returned") {
            firstTask.sentRequestCount(method: "node.invoke.result") == 2
        }
        try await waitUntil("receive loop rearmed before reconnect") {
            firstTask.hasPendingReceiveHandler()
        }
        firstTask.emitReceiveFailure()
        try await waitUntil("replacement socket created") {
            session.snapshotMakeCount() >= 2
        }
        let replayTask = try #require(session.latestTask())
        try await waitUntil("replacement socket receiving") {
            replayTask.hasPendingReceiveHandler()
        }
        replayTask.emitInvokeRequest(
            id: "computer-completed-replay",
            command: "computer.act",
            paramsJSON: paramsJSON,
            idempotencyKey: idempotencyKey)
        try await waitUntil("completed computer receipt returned after reconnect") {
            replayTask.sentRequestCount(method: "node.invoke.result") == 1
        }
        #expect(await probe.count() == 1)

        try await waitUntil("replacement socket rearmed after replay") {
            replayTask.hasPendingReceiveHandler()
        }
        replayTask.emitInvokeRequest(
            id: "computer-key-mismatch",
            command: "computer.act",
            paramsJSON: #"{"action":"type","text":"different","refWidth":1280}"#,
            idempotencyKey: idempotencyKey)
        try await waitUntil("idempotency mismatch returned") {
            replayTask.sentRequestCount(method: "node.invoke.result") == 2
        }
        let mismatch = try #require(replayTask.sentRequests(method: "node.invoke.result").last)
        let mismatchParams = try #require(mismatch["params"] as? [String: Any])
        let mismatchError = try #require(mismatchParams["error"] as? [String: Any])
        #expect(mismatchParams["ok"] as? Bool == false)
        #expect(mismatchError["code"] as? String == OpenClawNodeErrorCode.invalidRequest.rawValue)
        #expect(await probe.count() == 1)

        await gateway.disconnect()
    }

    @Test
    func `computer invoke receipts isolate canonically equivalent gateway owners`() async {
        let gateway = GatewayNodeSession()
        let probe = ComputerInvokeProbe()
        await probe.release()
        let paramsJSON = #"{"action":"type","text":"hello"}"#
        let idempotencyKey = "computer.act:v1:exact-owner"
        let composedScope = "gateway:gw-\u{00E9}"
        let decomposedScope = "gateway:gw-e\u{0301}"

        #expect(composedScope == decomposedScope)
        _ = await gateway.invokeComputerWithReceiptForTesting(
            requestId: "composed-owner",
            paramsJSON: paramsJSON,
            idempotencyKey: idempotencyKey,
            receiptScope: composedScope,
            onInvoke: { request in await probe.execute(request) })
        _ = await gateway.invokeComputerWithReceiptForTesting(
            requestId: "decomposed-owner",
            paramsJSON: paramsJSON,
            idempotencyKey: idempotencyKey,
            receiptScope: decomposedScope,
            onInvoke: { request in await probe.execute(request) })

        #expect(await probe.count() == 2)
    }

    @Test
    func `concurrent reconnect replays replace one stale receipt without duplicate input`() async throws {
        let gateway = GatewayNodeSession()
        let staleGate = AsyncGate()
        let freshProbe = ComputerInvokeProbe()
        let paramsJSON = #"{"action":"type","text":"hello"}"#
        let key = "computer.act:v1:stale-reconnect"
        let scope = "gateway:test"
        let stale = Task {
            await gateway.invokeComputerWithReceiptForTesting(
                requestId: "stale",
                paramsJSON: paramsJSON,
                idempotencyKey: key,
                receiptScope: scope,
                onInvoke: { request in
                    await staleGate.wait()
                    return BridgeInvokeResponse(
                        id: request.id,
                        ok: false,
                        error: OpenClawNodeError(
                            code: .unavailable,
                            message: "UNAVAILABLE: node route changed before dispatch"))
                })
        }
        try await waitUntil("stale receipt is in flight") {
            await staleGate.hasStarted()
        }

        let firstReplay = Task {
            await gateway.invokeComputerWithReceiptForTesting(
                requestId: "replay-1",
                paramsJSON: paramsJSON,
                idempotencyKey: key,
                receiptScope: scope,
                onInvoke: { request in await freshProbe.execute(request) })
        }
        let secondReplay = Task {
            await gateway.invokeComputerWithReceiptForTesting(
                requestId: "replay-2",
                paramsJSON: paramsJSON,
                idempotencyKey: key,
                receiptScope: scope,
                onInvoke: { request in await freshProbe.execute(request) })
        }
        try await waitUntil("both reconnect replays joined the stale receipt") {
            await gateway.computerReceiptJoinCountForTesting(
                idempotencyKey: key,
                receiptScope: scope) == 2
        }
        await staleGate.release()
        try await waitUntil("fresh receipt executes once") {
            await freshProbe.count() == 1
        }
        await freshProbe.release()

        #expect(await (stale.value).ok == false)
        #expect(await (firstReplay.value).ok)
        #expect(await (secondReplay.value).ok)
        #expect(await freshProbe.count() == 1)
    }

    @Test
    func `timed out computer receipt stays non evictable until operation settles`() async throws {
        let gateway = GatewayNodeSession()
        let blockedProbe = ComputerInvokeProbe()
        let replayProbe = ComputerInvokeProbe()
        await replayProbe.release()
        let scope = "gateway:timeout-capacity"
        let key = "computer.act:v1:unsettled"
        let paramsJSON = #"{"action":"type","text":"blocked"}"#

        let timedOut = await gateway.invokeComputerWithReceiptForTesting(
            requestId: "blocked-first",
            paramsJSON: paramsJSON,
            idempotencyKey: key,
            receiptScope: scope,
            timeoutMs: 1,
            onInvoke: { request in await blockedProbe.execute(request) })
        #expect(!timedOut.ok)
        try await waitUntil("timed out operation remains active") {
            await blockedProbe.count() == 1
        }

        // Fill past the bounded cache. Eviction may remove settled results, but
        // must preserve the timed-out receipt while its side effect is unresolved.
        for index in 0...256 {
            _ = await gateway.invokeComputerWithReceiptForTesting(
                requestId: "filler-\(index)",
                paramsJSON: #"{"action":"type","text":"filler"}"#,
                idempotencyKey: "computer.act:v1:filler-\(index)",
                receiptScope: scope,
                onInvoke: { request in
                    BridgeInvokeResponse(id: request.id, ok: true)
                })
        }

        let replay = await gateway.invokeComputerWithReceiptForTesting(
            requestId: "blocked-replay",
            paramsJSON: paramsJSON,
            idempotencyKey: key,
            receiptScope: scope,
            timeoutMs: 1,
            onInvoke: { request in await replayProbe.execute(request) })

        #expect(!replay.ok)
        #expect(await replayProbe.count() == 0)
        #expect(await blockedProbe.count() == 1)
        await blockedProbe.release()
    }

    @Test(.stateDirectoryIsolated)
    func `scanned setup code prefers bootstrap auth over stored device token`() async throws {
        let identity = DeviceIdentityStore.loadOrCreate()
        _ = DeviceAuthStore.storeToken(
            deviceId: identity.deviceId,
            role: "operator",
            token: "stored-device-token")

        let session = FakeGatewayWebSocketSession()
        let gateway = GatewayNodeSession()
        let options = GatewayConnectOptions(
            role: "operator",
            scopes: ["operator.read"],
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "openclaw-ios-test",
            clientMode: "ui",
            clientDisplayName: "iOS Test",
            includeDeviceIdentity: true)

        try await gateway.connect(
            url: #require(URL(string: "ws://example.invalid")),
            credentials: .init(bootstrapToken: "fresh-bootstrap-token"),
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: session),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { req in
                BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil)
            })

        let auth = try #require(session.latestTask()?.latestConnectAuth())
        #expect(auth["bootstrapToken"] as? String == "fresh-bootstrap-token")
        #expect(auth["token"] == nil)
        #expect(auth["deviceToken"] == nil)

        await gateway.disconnect()
    }

    @Test(.stateDirectoryIsolated)
    func `credentialless setup handoff does not send a stored device token`() async throws {
        let identity = DeviceIdentityStore.loadOrCreate()
        _ = DeviceAuthStore.storeToken(
            deviceId: identity.deviceId,
            role: "node",
            token: "previous-gateway-device-token")

        let session = FakeGatewayWebSocketSession()
        let gateway = GatewayNodeSession()
        let options = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "openclaw-ios-test",
            clientMode: "node",
            clientDisplayName: "iOS Test",
            includeDeviceIdentity: true,
            allowStoredDeviceAuth: false)

        try await gateway.connect(
            url: #require(URL(string: "ws://new-gateway.example.invalid")),
            credentials: .init(),
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: session),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { req in
                BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil)
            })

        let task = try #require(session.latestTask())
        let auth = try #require(task.latestConnectAuth())
        #expect(auth["token"] == nil)
        #expect(auth["bootstrapToken"] == nil)
        #expect(auth["deviceToken"] == nil)
        #expect(task.latestConnectDevice() != nil)
        #expect(await gateway.currentIssuedDeviceAuthRoles() == [])

        await gateway.disconnect()
    }

    @Test(.stateDirectoryIsolated)
    func `stored device token cannot cross gateway owner`() async throws {
        let identity = DeviceIdentityStore.loadOrCreate()
        _ = DeviceAuthStore.storeToken(
            deviceId: identity.deviceId,
            role: "node",
            token: "gateway-a-device-token",
            gatewayID: "gateway-a")

        let session = FakeGatewayWebSocketSession()
        let gateway = GatewayNodeSession()
        let options = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "openclaw-ios-test",
            clientMode: "node",
            clientDisplayName: "iOS Test",
            includeDeviceIdentity: true,
            allowStoredDeviceAuth: true,
            deviceAuthGatewayID: "gateway-b")

        try await gateway.connect(
            url: #require(URL(string: "ws://gateway-b.example.invalid")),
            credentials: .init(),
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: session),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { req in
                BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil)
            })

        let auth = try #require(session.latestTask()?.latestConnectAuth())
        #expect(auth["token"] == nil)
        #expect(auth["deviceToken"] == nil)
        #expect(DeviceAuthStore.loadToken(
            deviceId: identity.deviceId,
            role: "node",
            gatewayID: "gateway-a")?.token == "gateway-a-device-token")

        await gateway.disconnect()
    }

    @Test(.stateDirectoryIsolated)
    func `share extension identity profile uses separate node identity and token store`() async throws {
        let primaryIdentity = DeviceIdentityStore.loadOrCreate()
        _ = DeviceAuthStore.storeToken(
            deviceId: primaryIdentity.deviceId,
            role: "node",
            token: "primary-node-token")

        let session = FakeGatewayWebSocketSession(helloAuth: [
            "deviceToken": "share-node-token",
            "role": "node",
            "scopes": [],
        ])
        let gateway = GatewayNodeSession()
        let options = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "openclaw-ios",
            clientMode: "node",
            clientDisplayName: "OpenClaw Share",
            deviceIdentityProfile: .shareExtension,
            includeDeviceIdentity: true)

        try await gateway.connect(
            url: #require(URL(string: "ws://example.invalid")),
            credentials: .init(password: "shared-password"),
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: session),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { req in
                BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil)
            })

        let shareDevice = try #require(session.latestTask()?.latestConnectDevice())
        let shareDeviceId = try #require(shareDevice["id"] as? String)
        #expect(shareDeviceId != primaryIdentity.deviceId)
        #expect(DeviceAuthStore.loadToken(deviceId: primaryIdentity.deviceId, role: "node")?
            .token == "primary-node-token")
        #expect(DeviceAuthStore.loadToken(deviceId: shareDeviceId, role: "node") == nil)
        #expect(
            DeviceAuthStore
                .loadToken(deviceId: shareDeviceId, role: "node", profile: .shareExtension)?.token ==
                "share-node-token")

        await gateway.disconnect()
    }

    @Test
    func `password takes precedence over bootstrap token`() async throws {
        let session = FakeGatewayWebSocketSession()
        let gateway = GatewayNodeSession()
        let options = GatewayConnectOptions(
            role: "operator",
            scopes: ["operator.read"],
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "openclaw-ios-test",
            clientMode: "ui",
            clientDisplayName: "iOS Test",
            includeDeviceIdentity: false)

        try await gateway.connect(
            url: #require(URL(string: "ws://example.invalid")),
            credentials: .init(
                bootstrapToken: "stale-bootstrap-token",
                password: "shared-password"),
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: session),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { req in
                BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil)
            })

        let auth = try #require(session.latestTask()?.latestConnectAuth())
        #expect(auth["password"] as? String == "shared-password")
        #expect(auth["bootstrapToken"] == nil)
        #expect(auth["token"] == nil)

        await gateway.disconnect()
    }

    @Test
    func `connect failure preserves protocol mismatch details`() async throws {
        let session = FakeGatewayWebSocketSession(connectError: [
            "code": "INVALID_REQUEST",
            "message": "protocol mismatch",
            "details": [
                "code": "PROTOCOL_MISMATCH",
                "clientMinProtocol": 4,
                "clientMaxProtocol": 4,
                "expectedProtocol": 5,
                "minimumProbeProtocol": 4,
            ],
        ])
        let gateway = GatewayNodeSession()
        let options = GatewayConnectOptions(
            role: "operator",
            scopes: ["operator.read"],
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "openclaw-ios-test",
            clientMode: "ui",
            clientDisplayName: "iOS Test",
            includeDeviceIdentity: false)

        do {
            try await gateway.connect(
                url: #require(URL(string: "ws://example.invalid")),
                credentials: .init(token: "shared-token"),
                connectOptions: options,
                sessionBox: WebSocketSessionBox(session: session),
                onConnected: {},
                onDisconnected: { _ in },
                onInvoke: { req in
                    BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil)
                })
            Issue.record("connect unexpectedly succeeded")
        } catch let error as GatewayConnectAuthError {
            #expect(error.detail == .protocolMismatch)
            #expect(error.clientMinProtocol == 4)
            #expect(error.clientMaxProtocol == 4)
            #expect(error.expectedProtocol == 5)
            #expect(error.minimumProbeProtocol == 4)

            let problem = GatewayConnectionProblemMapper.map(error: error)
            #expect(problem?.kind == .protocolMismatch)
            #expect(problem?.owner == .iphone)
            #expect(problem?
                .message == "This app is older than the gateway. Update OpenClaw on this device, then retry.")
            #expect(problem?.pauseReconnect == true)
            #expect(problem?.retryable == false)
        } catch {
            Issue.record("unexpected error type: \(error)")
        }

        await gateway.disconnect()
    }

    @Test
    func `changed session box rebuilds existing gateway channel`() async throws {
        let firstSession = FakeGatewayWebSocketSession()
        let secondSession = FakeGatewayWebSocketSession()
        let gateway = GatewayNodeSession()
        let options = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "openclaw-ios-test",
            clientMode: "node",
            clientDisplayName: "iOS Test",
            includeDeviceIdentity: false)

        try await gateway.connect(
            url: #require(URL(string: "wss://example.invalid")),
            credentials: .init(token: "shared-token"),
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: firstSession),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { req in
                BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil)
            })

        try await gateway.connect(
            url: #require(URL(string: "wss://example.invalid")),
            credentials: .init(token: "shared-token"),
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: secondSession),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { req in
                BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil)
            })

        #expect(firstSession.snapshotMakeCount() == 1)
        #expect(secondSession.snapshotMakeCount() == 1)

        await gateway.disconnect()
    }

    @Test(.stateDirectoryIsolated)
    func `bootstrap hello stores additional device tokens`() async throws {
        let identity = DeviceIdentityStore.loadOrCreate()
        let session = FakeGatewayWebSocketSession(helloAuth: [
            "deviceToken": "node-device-token",
            "role": "node",
            "scopes": [],
            "issuedAtMs": 1000,
            "deviceTokens": [
                [
                    "deviceToken": "operator-device-token",
                    "role": "operator",
                    "scopes": [
                        "node.exec",
                        "operator.admin",
                        "operator.approvals",
                        "operator.pairing",
                        "operator.read",
                        "operator.talk.secrets",
                        "operator.write",
                    ],
                    "issuedAtMs": 1001,
                ],
            ],
        ])
        let gateway = GatewayNodeSession()
        let options = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "openclaw-ios-test",
            clientMode: "node",
            clientDisplayName: "iOS Test",
            includeDeviceIdentity: true)

        try await gateway.connect(
            url: #require(URL(string: "wss://example.invalid")),
            credentials: .init(bootstrapToken: "fresh-bootstrap-token"),
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: session),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { req in
                BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil)
            })

        let nodeEntry = try #require(DeviceAuthStore.loadToken(deviceId: identity.deviceId, role: "node"))
        let operatorEntry = try #require(DeviceAuthStore.loadToken(deviceId: identity.deviceId, role: "operator"))
        #expect(nodeEntry.token == "node-device-token")
        #expect(nodeEntry.scopes == [])
        #expect(operatorEntry.token == "operator-device-token")
        #expect(operatorEntry.scopes == [
            "operator.admin",
            "operator.approvals",
            "operator.read",
            "operator.talk.secrets",
            "operator.write",
        ])
        #expect(await gateway.currentIssuedDeviceAuthRoles() == ["node", "operator"])

        await gateway.disconnect()
    }

    @Test(.stateDirectoryIsolated)
    func `failed device token write is not reported as an issued role`() async throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        let blocker = tempDir.appendingPathComponent("not-a-directory", isDirectory: false)
        try Data().write(to: blocker)
        // Repoint the pinned state dir at a plain file to force write failures;
        // the isolation trait restores the env var after the test.
        setenv("OPENCLAW_STATE_DIR", blocker.path, 1)
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let session = FakeGatewayWebSocketSession(helloAuth: [
            "deviceToken": "node-device-token",
            "role": "node",
            "scopes": [],
        ])
        let gateway = GatewayNodeSession()
        let options = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "openclaw-ios-test",
            clientMode: "node",
            clientDisplayName: "iOS Test",
            includeDeviceIdentity: true)

        try await gateway.connect(
            url: #require(URL(string: "wss://example.invalid")),
            credentials: .init(bootstrapToken: "fresh-bootstrap-token"),
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: session),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { req in
                BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil)
            })

        #expect(await gateway.currentIssuedDeviceAuthRoles().isEmpty)
        await gateway.disconnect()
    }

    @Test(.stateDirectoryIsolated)
    func `non bootstrap hello stores primary device token but not additional bootstrap tokens`() async throws {
        let identity = DeviceIdentityStore.loadOrCreate()
        let session = FakeGatewayWebSocketSession(helloAuth: [
            "deviceToken": "server-node-token",
            "role": "node",
            "scopes": [],
            "deviceTokens": [
                [
                    "deviceToken": "server-operator-token",
                    "role": "operator",
                    "scopes": ["operator.admin"],
                ],
            ],
        ])
        let gateway = GatewayNodeSession()
        let options = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "openclaw-ios-test",
            clientMode: "node",
            clientDisplayName: "iOS Test",
            includeDeviceIdentity: true)

        try await gateway.connect(
            url: #require(URL(string: "wss://example.invalid")),
            credentials: .init(token: "shared-token"),
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: session),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { req in
                BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil)
            })

        let nodeEntry = try #require(DeviceAuthStore.loadToken(deviceId: identity.deviceId, role: "node"))
        #expect(nodeEntry.token == "server-node-token")
        #expect(nodeEntry.scopes == [])
        #expect(DeviceAuthStore.loadToken(deviceId: identity.deviceId, role: "operator") == nil)

        await gateway.disconnect()
    }

    @Test(.stateDirectoryIsolated)
    func `untrusted bootstrap hello does not persist bootstrap handoff tokens`() async throws {
        let identity = DeviceIdentityStore.loadOrCreate()
        let session = FakeGatewayWebSocketSession(helloAuth: [
            "deviceToken": "untrusted-node-token",
            "role": "node",
            "scopes": [],
            "deviceTokens": [
                [
                    "deviceToken": "untrusted-operator-token",
                    "role": "operator",
                    "scopes": [
                        "operator.approvals",
                        "operator.read",
                    ],
                ],
            ],
        ])
        let gateway = GatewayNodeSession()
        let options = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "openclaw-ios-test",
            clientMode: "node",
            clientDisplayName: "iOS Test",
            includeDeviceIdentity: true)

        try await gateway.connect(
            url: #require(URL(string: "ws://example.invalid")),
            credentials: .init(bootstrapToken: "fresh-bootstrap-token"),
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: session),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { req in
                BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil)
            })

        #expect(DeviceAuthStore.loadToken(deviceId: identity.deviceId, role: "node") == nil)
        #expect(DeviceAuthStore.loadToken(deviceId: identity.deviceId, role: "operator") == nil)

        await gateway.disconnect()
    }

    @Test(.stateDirectoryIsolated)
    func `private lan bootstrap persists handoff tokens for reconnect`() async throws {
        let identity = DeviceIdentityStore.loadOrCreate()
        let url = try #require(URL(string: "ws://192.168.50.164:18889"))
        let bootstrapSession = FakeGatewayWebSocketSession(helloAuth: [
            "deviceToken": "lan-node-token",
            "role": "node",
            "scopes": [],
            "deviceTokens": [
                [
                    "deviceToken": "lan-operator-token",
                    "role": "operator",
                    "scopes": [
                        "operator.approvals",
                        "operator.read",
                    ],
                ],
            ],
        ])
        let gateway = GatewayNodeSession()
        let options = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "openclaw-ios-test",
            clientMode: "node",
            clientDisplayName: "iOS Test",
            includeDeviceIdentity: true)

        try await gateway.connect(
            url: url,
            credentials: .init(bootstrapToken: "fresh-bootstrap-token"),
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: bootstrapSession),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { req in
                BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil)
            })
        await gateway.disconnect()

        let nodeEntry = try #require(DeviceAuthStore.loadToken(deviceId: identity.deviceId, role: "node"))
        let operatorEntry = try #require(DeviceAuthStore.loadToken(deviceId: identity.deviceId, role: "operator"))
        #expect(nodeEntry.token == "lan-node-token")
        #expect(nodeEntry.scopes == [])
        #expect(operatorEntry.token == "lan-operator-token")
        #expect(operatorEntry.scopes == [
            "operator.approvals",
            "operator.read",
        ])

        let reconnectSession = FakeGatewayWebSocketSession()
        try await gateway.connect(
            url: url,
            credentials: .init(),
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: reconnectSession),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { req in
                BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil)
            })

        let reconnectAuth = try #require(reconnectSession.latestTask()?.latestConnectAuth())
        #expect(reconnectAuth["token"] as? String == "lan-node-token")
        #expect(reconnectAuth["bootstrapToken"] == nil)
        #expect(reconnectAuth["deviceToken"] == nil)

        await gateway.disconnect()
    }

    @Test(.stateDirectoryIsolated)
    func `token mismatch retries stored device token only for trusted loopback hosts`() async throws {
        let identity = DeviceIdentityStore.loadOrCreate()
        _ = DeviceAuthStore.storeToken(
            deviceId: identity.deviceId,
            role: "operator",
            token: "stored-device-token")

        let options = GatewayConnectOptions(
            role: "operator",
            scopes: ["operator.read"],
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "openclaw-ios-test",
            clientMode: "ui",
            clientDisplayName: "iOS Test",
            includeDeviceIdentity: true)

        let connectError: [String: Any] = [
            "code": GatewayConnectAuthDetailCode.authTokenMismatch.rawValue,
            "message": "token mismatch",
            "details": [
                "canRetryWithDeviceToken": true,
            ],
        ]

        func retryAuth(for rawURL: String) async throws -> [String: Any] {
            let session = FakeGatewayWebSocketSession(connectError: connectError)
            let gateway = GatewayNodeSession()
            let url = try #require(URL(string: rawURL))

            for _ in 0..<2 {
                do {
                    try await gateway.connect(
                        url: url,
                        credentials: .init(token: "shared-gateway-token"),
                        connectOptions: options,
                        sessionBox: WebSocketSessionBox(session: session),
                        onConnected: {},
                        onDisconnected: { _ in },
                        onInvoke: { req in
                            BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil)
                        })
                    Issue.record("connect unexpectedly succeeded")
                } catch let error as GatewayConnectAuthError {
                    #expect(error.detail == .authTokenMismatch)
                }
            }

            let retryAuth = try #require(session.latestTask()?.latestConnectAuth())
            await gateway.disconnect()
            return retryAuth
        }

        for rawURL in [
            "ws://127.attacker.example:18789",
            "ws://0.0.0.0:18789",
            "ws://[::]:18789",
        ] {
            let retryAuth = try await retryAuth(for: rawURL)
            #expect(retryAuth["token"] as? String == "shared-gateway-token")
            #expect(retryAuth["deviceToken"] == nil)
        }

        for rawURL in [
            "ws://localhost:18789",
            "ws://127.0.0.2:18789",
            "ws://[::1]:18789",
        ] {
            let retryAuth = try await retryAuth(for: rawURL)
            #expect(retryAuth["token"] as? String == "shared-gateway-token")
            #expect(retryAuth["deviceToken"] as? String == "stored-device-token")
        }
    }

    @Test
    func `normalize canvas host url preserves explicit secure canvas port`() {
        let normalized = canonicalizeCanvasHostUrl(
            raw: "https://canvas.example.com:9443/__openclaw__/cap/token",
            activeURL: URL(string: "wss://gateway.example.com"))

        #expect(normalized == "https://canvas.example.com:9443/__openclaw__/cap/token")
    }

    @Test
    func `normalize canvas host url backfills gateway host for loopback canvas`() {
        let normalized = canonicalizeCanvasHostUrl(
            raw: "http://127.0.0.1:18789/__openclaw__/cap/token",
            activeURL: URL(string: "wss://gateway.example.com:7443"))

        #expect(normalized == "https://gateway.example.com:7443/__openclaw__/cap/token")
    }

    @Test
    func `watch invoke payload decodes without bridge frame type`() throws {
        let data = Data(
            #"{"id":"invoke-1","nodeId":"watch-1","command":"device.info","paramsJSON":null,"timeoutMs":2000}"#
                .utf8)
        let request = try JSONDecoder().decode(NodeInvokeRequestEvent.self, from: data)

        #expect(request.id == "invoke-1")
        #expect(request.nodeid == "watch-1")
        #expect(request.command == "device.info")
        #expect(request.paramsjson == nil)
        #expect(request.timeoutms == 2000)
    }

    @Test
    func `invoke with timeout returns underlying response before timeout`() async {
        let request = BridgeInvokeRequest(id: "1", command: "x", paramsJSON: nil)
        let response = await GatewayNodeSession.invokeWithTimeout(
            request: request,
            timeoutMs: 50,
            onInvoke: { req in
                #expect(req.id == "1")
                return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: "{}", error: nil)
            })

        #expect(response.ok == true)
        #expect(response.error == nil)
        #expect(response.payloadJSON == "{}")
    }

    @Test
    func `invoke with timeout returns timeout error`() async {
        let request = BridgeInvokeRequest(id: "abc", command: "x", paramsJSON: nil)
        let response = await GatewayNodeSession.invokeWithTimeout(
            request: request,
            timeoutMs: 10,
            onInvoke: { _ in
                try? await Task.sleep(nanoseconds: 200_000_000) // 200ms
                return BridgeInvokeResponse(id: "abc", ok: true, payloadJSON: "{}", error: nil)
            })

        #expect(response.ok == false)
        #expect(response.error?.code == .unavailable)
        #expect(response.error?.message.contains("timed out") == true)
    }

    @Test
    func `invoke timeout cancels the in-flight operation`() async {
        let cancellation = InvokeCancellationFlag()
        let response = await GatewayNodeSession.invokeWithTimeout(
            request: BridgeInvokeRequest(id: "cancelled", command: "x", paramsJSON: nil),
            timeoutMs: 10,
            onInvoke: { request in
                await withTaskCancellationHandler {
                    try? await Task.sleep(for: .seconds(1))
                    return BridgeInvokeResponse(id: request.id, ok: true, payloadJSON: nil, error: nil)
                } onCancel: {
                    cancellation.markCancelled()
                }
            })

        for _ in 0..<50 where !cancellation.isCancelled() {
            try? await Task.sleep(for: .milliseconds(1))
        }
        #expect(response.ok == false)
        #expect(cancellation.isCancelled())
    }

    @Test
    func `invoke with timeout zero disables timeout`() async {
        let request = BridgeInvokeRequest(id: "1", command: "x", paramsJSON: nil)
        let response = await GatewayNodeSession.invokeWithTimeout(
            request: request,
            timeoutMs: 0,
            onInvoke: { req in
                try? await Task.sleep(nanoseconds: 5_000_000)
                return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil)
            })

        #expect(response.ok == true)
        #expect(response.error == nil)
    }

    @Test
    func `invoke timeout clamps hostile integer without trapping`() async {
        let response = await GatewayNodeSession.invokeWithTimeout(
            request: BridgeInvokeRequest(id: "large-timeout", command: "computer.act", paramsJSON: nil),
            timeoutMs: .max,
            onInvoke: { request in
                try? await Task.sleep(nanoseconds: 1_000_000)
                return BridgeInvokeResponse(id: request.id, ok: true, payloadJSON: nil, error: nil)
            })

        #expect(response.ok == true)
    }

    @Test
    func `gateway request timeout zero disables the client deadline`() {
        #expect(GatewayChannelActor.resolveRequestTimeoutMs(0, defaultMs: 15000) == nil)
        #expect(GatewayChannelActor.resolveRequestTimeoutMs(nil, defaultMs: 15000) == 15000)
        #expect(GatewayChannelActor.resolveRequestTimeoutMs(30000, defaultMs: 15000) == 30000)
    }

    @Test
    func `server event subscription filters before buffering`() async {
        let gateway = GatewayNodeSession()
        let subscription = await gateway.makeServerEventSubscription(
            bufferingNewest: 1,
            matching: { $0.event == "target" })
        defer { subscription.cancel() }
        let stream = subscription.events

        await gateway._test_broadcastServerEvent(EventFrame(type: "event", event: "noise"))
        await gateway._test_broadcastServerEvent(EventFrame(type: "event", event: "target"))
        await gateway._test_broadcastServerEvent(EventFrame(type: "event", event: "noise"))

        var iterator = stream.makeAsyncIterator()
        let event = await iterator.next()
        #expect(event?.event == "target")
    }

    @Test
    func `main session key follows the current node snapshot route`() async throws {
        let session = FakeGatewayWebSocketSession(
            helloSessionDefaults: ["mainSessionKey": " agent:main:main "],
            helloDelayNanoseconds: 750_000_000)
        let gateway = GatewayNodeSession()
        let capturedMainSessionKey = StringCapture()
        let options = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "openclaw-macos",
            clientMode: "node",
            clientDisplayName: "macOS Test",
            includeDeviceIdentity: false)

        try await gateway.connect(
            url: #require(URL(string: "ws://example.invalid")),
            credentials: .init(),
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: session),
            onConnected: {
                let route = await gateway.currentRoute()
                let key: String? = if let route {
                    await gateway.waitForCurrentMainSessionKey(ifCurrentRoute: route)
                } else {
                    nil
                }
                await capturedMainSessionKey.set(key)
            },
            onDisconnected: { _ in },
            onInvoke: { req in
                BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil)
            })

        let route = try #require(await gateway.currentRoute())
        #expect(await capturedMainSessionKey.get() == "agent:main:main")
        #expect(await gateway.currentMainSessionKey(ifCurrentRoute: route) == "agent:main:main")

        await gateway.disconnect()
        #expect(await gateway.currentMainSessionKey(ifCurrentRoute: route) == nil)
    }

    @Test
    func `emits synthetic seq gap after reconnect snapshot`() async throws {
        let session = FakeGatewayWebSocketSession()
        let gateway = GatewayNodeSession()
        let options = GatewayConnectOptions(
            role: "operator",
            scopes: ["operator.read"],
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "openclaw-ios-test",
            clientMode: "ui",
            clientDisplayName: "iOS Test",
            includeDeviceIdentity: false)

        let stream = await gateway.subscribeServerEvents(bufferingNewest: 32)
        let probe = SeqGapProbe()
        let listenTask = Task {
            for await evt in stream {
                if evt.event == "seqGap" {
                    await probe.mark()
                    return
                }
            }
        }

        try await gateway.connect(
            url: #require(URL(string: "ws://example.invalid")),
            credentials: .init(),
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: session),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { req in
                BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil)
            })

        let firstTask = try #require(session.latestTask())
        firstTask.emitReceiveFailure()

        try await waitUntil("reconnect socket created") {
            session.snapshotMakeCount() >= 2
        }
        try await waitUntil("synthetic seqGap broadcast") {
            await probe.value()
        }

        listenTask.cancel()
        await gateway.disconnect()
    }
}
