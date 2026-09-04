import CoreLocation
import Foundation
import Testing
@testable import OpenClaw
@testable import OpenClawKit

/// Real node dispatch and action queue; only the desktop effectors are synthetic.
/// This does not exercise ComputerActionService's screen/window executor routing.
@MainActor
final class MacNodeComputerExecutionFixture {
    static let firstExecution = "11111111-1111-4111-8111-111111111111"
    static let secondExecution = "22222222-2222-4222-8222-222222222222"
    static let unknownExecution = "33333333-3333-4333-8333-333333333333"

    @MainActor
    final class Gate {
        private var opened = false
        private var waiters: [CheckedContinuation<Void, Never>] = []

        /// Deliberately ignores cancellation to model an already-started native operation.
        func wait() async {
            guard !self.opened else { return }
            await withCheckedContinuation { self.waiters.append($0) }
        }

        func open() {
            self.opened = true
            let waiters = self.waiters
            self.waiters.removeAll()
            for waiter in waiters {
                waiter.resume()
            }
        }
    }

    @MainActor
    final class Services: MacNodeRuntimeMainActorServices {
        var blockedActions: [String: Gate] = [:]
        var checks: [String: @MainActor () throws -> Void] = [:]
        private(set) var events: [String] = []
        private(set) var heldInput: String?
        private(set) var releaseAttempts = 0
        private(set) var initializationStarted = false
        let initialization = Gate()
        private(set) var queue: ComputerActionExecutionQueue!

        func setQueue(_ queue: ComputerActionExecutionQueue) {
            self.queue = queue
        }

        var releaseAllowed = true
        private(set) var snapshotCount = 0
        private(set) var invalidationCount = 0
        var invalidationError: (any Error)?

        func initialize() async {
            self.initializationStarted = true
            await self.initialization.wait()
        }

        func performComputerAct(
            _ params: OpenClawComputerActParams,
            lifecycleGeneration: UInt64) async throws -> OpenClawComputerActResult
        {
            let check = self.queue.executionCheck(lifecycleGeneration: lifecycleGeneration)
            try check()
            let label = try #require(params.text)
            self.checks[label] = check
            self.events.append("start:\(label)")
            self.heldInput = label
            await self.blockedActions[label]?.wait()
            // Deliberately ignore cancellation: the real queue must catch up.
            self.heldInput = label
            self.events.append("finish:\(label)")
            return OpenClawComputerActResult(ok: true)
        }

        func releaseHeldInput() -> Bool {
            self.releaseAttempts += 1
            guard self.releaseAllowed else { return false }
            if let heldInput = self.heldInput {
                self.events.append("release:\(heldInput)")
                self.heldInput = nil
            }
            return true
        }

        func invalidateComputerReferences() async throws {
            self.invalidationCount += 1
            if let invalidationError { throw invalidationError }
        }

        func unblock() {
            self.releaseAllowed = true
            self.initialization.open()
            for gate in self.blockedActions.values {
                gate.open()
            }
        }

        private struct UnexpectedEffector: Error {}

        func snapshotScreen(
            screenIndex _: Int?, maxWidth _: Int?, quality _: Double?,
            format _: OpenClawScreenSnapshotFormat?,
            checkExecutionAllowed: @MainActor () throws -> Void) async throws -> ScreenSnapshotResult
        {
            try checkExecutionAllowed()
            self.snapshotCount += 1
            return ScreenSnapshotResult(
                data: Data("synthetic".utf8),
                format: .png,
                width: 1,
                height: 1,
                displayFrameId: "synthetic-frame")
        }

        func recordScreen(
            screenIndex _: Int?, durationMs _: Int?, fps _: Double?,
            includeAudio _: Bool?, outPath _: String?) async throws -> (path: String, hasAudio: Bool)
        {
            throw UnexpectedEffector()
        }

        func locationAuthorizationStatus() -> CLAuthorizationStatus {
            .denied
        }

        func locationAccuracyAuthorization() -> CLAccuracyAuthorization {
            .reducedAccuracy
        }

        func currentLocation(
            desiredAccuracy _: OpenClawLocationAccuracy,
            maxAgeMs _: Int?, timeoutMs _: Int?) async throws -> CLLocation
        {
            throw UnexpectedEffector()
        }
    }

    struct Response: Decodable, Sendable {
        let id: String
        let ok: Bool
        let payloadJSON: String?
        let error: OpenClawNodeError?

        var bridge: BridgeInvokeResponse {
            BridgeInvokeResponse(id: self.id, ok: self.ok, payloadJSON: self.payloadJSON, error: self.error)
        }
    }

    private struct OutgoingFrame: Decodable, Sendable {
        let method: String
        let params: Response
    }

    let services = Services()
    let session = GatewayNodeSession()
    private(set) var responses: [String: Response] = [:]
    private(set) var cancellations: Set<String> = []
    private(set) var invocations: Set<String> = []
    private(set) var routes: [String: GatewayNodeInvocationRoute] = [:]
    private(set) var responseEvents: [String: [String]] = [:]
    private var socket: GatewayTestWebSocketTask?
    private lazy var runtime = MacNodeRuntime(
        makeMainActorServices: { [services] queue in
            await services.setQueue(queue)
            await services.initialize()
            return services
        },
        computerControlEnabled: { true },
        computerControlProvider: { .peekaboo })

    func connect(suspendInitialization: Bool = false, runtime override: MacNodeRuntime? = nil) async throws {
        if !suspendInitialization { self.services.initialization.open() }
        let transport = GatewayTestWebSocketSession(taskFactory: { [weak self] in
            GatewayTestWebSocketTask(sendHook: { [weak self] _, message, _ in
                let data: Data
                switch message {
                case let .data(value): data = value
                case let .string(value): data = Data(value.utf8)
                @unknown default: return
                }
                guard let frame = try? JSONDecoder().decode(OutgoingFrame.self, from: data),
                      frame.method == "node.invoke.result"
                else { return }
                await self?.record(frame.params)
            })
        })
        let runtime = override ?? self.runtime
        try await self.session.connect(
            url: #require(URL(string: "ws://computer-execution.invalid")),
            credentials: .init(),
            connectOptions: GatewayConnectOptions(
                role: "node", scopes: [], caps: ["computer"], commands: ["computer.act"],
                permissions: [:], clientId: "openclaw-macos", clientMode: "node",
                clientDisplayName: "Computer Execution Fixture",
                includeDeviceIdentity: false, allowStoredDeviceAuth: false),
            sessionBox: WebSocketSessionBox(session: transport),
            onConnected: {},
            onDisconnected: { _ in await runtime.releaseHeldComputerInput() },
            onInvoke: { [weak self] req in
                await self?.recordInvocation(req.id, route: GatewayNodeSession.invocationRoute)
                return await runtime.handleInvoke(req)
            },
            onInvokeCancel: { [weak self] id in await self?.recordCancellation(id) },
            onRouteInvalidated: { await runtime.releaseHeldComputerInput() })
        let socket = try #require(transport.latestTask())
        self.socket = socket
    }

    private func record(_ response: Response) {
        self.responses[response.id] = response
        self.responseEvents[response.id] = self.services.events
    }

    private func recordInvocation(_ id: String, route: GatewayNodeInvocationRoute?) {
        self.invocations.insert(id)
        self.routes[id] = route
    }

    func staleClose(_ id: String, execution: String, route: GatewayNodeInvocationRoute) async throws -> Bool {
        let params = try String(decoding: JSONEncoder().encode([
            "action": "__close_execution", "executionId": execution, "reason": "test_complete",
        ]), as: UTF8.self)
        return await GatewayNodeSession.$invocationRoute.withValue(route) {
            await self.runtime.handleInvoke(BridgeInvokeRequest(id: id, command: "computer.act", paramsJSON: params)).ok
        }
    }

    func staleRelease(route: GatewayNodeInvocationRoute) async {
        await GatewayNodeSession.$invocationRoute.withValue(route) {
            await self.runtime.releaseHeldComputerInput()
        }
    }

    private func recordCancellation(_ id: String) {
        self.cancellations.insert(id)
    }

    func sendAction(_ id: String, execution: String, label: String) async throws {
        try await self.sendInvoke(id, params: [
            "action": "left_mouse_down", "executionId": execution, "text": label,
        ])
    }

    func sendClose(_ id: String, execution: String) async throws {
        // Raw JSON deliberately compiles before native decoding gains managed close.
        try await self.sendInvoke(id, params: [
            "action": "__close_execution", "executionId": execution, "reason": "test_complete",
        ])
    }

    func sendSnapshot(_ id: String, execution: String? = nil) async throws {
        try await self.sendInvoke(id, params: execution.map { ["executionId": $0] } ?? [:], command: "screen.snapshot")
    }

    private func sendInvoke(_ id: String, params: [String: String], command: String = "computer.act") async throws {
        let paramsJSON = try String(decoding: JSONEncoder().encode(params), as: UTF8.self)
        try await self.emit(event: "node.invoke.request", payload: [
            "id": id, "nodeId": "synthetic-node", "command": command,
            "paramsJSON": paramsJSON, "timeoutMs": 0,
        ])
    }

    func cancel(_ id: String) async throws {
        try await self.emit(event: "node.invoke.cancel", payload: ["invokeId": id])
        try await self.waitUntil { self.cancellations.contains(id) }
    }

    private func emit(event: String, payload: [String: Any]) async throws {
        let socket = try #require(self.socket)
        try await self.waitUntil { socket.hasPendingReceiveHandler() }
        let data = try JSONSerialization.data(withJSONObject: [
            "type": "event", "event": event, "payload": payload,
        ])
        socket.emitReceiveSuccessOnce(.data(data))
    }

    func response(_ id: String) async throws -> Response {
        try await self.waitUntil { self.responses[id] != nil }
        return try #require(self.responses[id])
    }

    func waitUntil(_ predicate: @MainActor () -> Bool) async throws {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(5))
        while !predicate(), clock.now < deadline {
            await Task.yield()
        }
        try #require(predicate())
    }

    /// Supplies a real live dispatch route to isolated queue tests without a production seam.
    static func runWithRoute<Value>(
        _ body: @MainActor (GatewayNodeInvocationRoute) async throws -> Value) async throws -> Value
    {
        try await Self().run { fixture in
            try await fixture.connect()
            try await fixture.sendSnapshot("route")
            _ = try await fixture.response("route")
            return try await body(#require(fixture.routes["route"]))
        }
    }

    func invoke(_ request: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        var payload: [String: Any] = [
            "id": request.id, "nodeId": request.nodeId ?? "synthetic-node",
            "command": request.command, "timeoutMs": 0,
        ]
        payload["paramsJSON"] = request.paramsJSON
        payload["idempotencyKey"] = request.idempotencyKey
        try await self.emit(event: "node.invoke.request", payload: payload)
        return try await self.response(request.id).bridge
    }

    func run<Value>(
        _ body: @MainActor (MacNodeComputerExecutionFixture) async throws -> Value) async throws -> Value
    {
        do {
            let result = try await body(self)
            self.services.unblock()
            await self.session.disconnect()
            return result
        } catch {
            self.services.unblock()
            await self.session.disconnect()
            throw error
        }
    }
}
