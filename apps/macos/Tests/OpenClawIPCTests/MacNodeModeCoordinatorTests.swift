import Foundation
import OpenClawIPC
import OpenClawKit
import Testing
@testable import OpenClaw

private actor CoordinatorInvokeLifecycleProbe {
    private var invokeStarted = false
    private var invokeCancelled = false
    private var routeInvalidated = false
    private let routeInvalidationGate: AsyncTestGate
    private var successorConnected = false
    private var events: [String] = []

    init(routeInvalidationGate: AsyncTestGate) {
        self.routeInvalidationGate = routeInvalidationGate
    }

    func invoke(_ request: BridgeInvokeRequest) async -> BridgeInvokeResponse {
        self.invokeStarted = true
        do {
            try await Task.sleep(for: .seconds(30))
            return BridgeInvokeResponse(id: request.id, ok: true)
        } catch {
            self.invokeCancelled = true
            return BridgeInvokeResponse(
                id: request.id,
                ok: false,
                error: OpenClawNodeError(
                    code: .unavailable,
                    message: "UNAVAILABLE: canceled by route invalidation"))
        }
    }

    func recordInvalidation() async {
        self.routeInvalidated = true
        self.events.append("invalidation-started")
        await self.routeInvalidationGate.wait()
        self.events.append("invalidation-finished")
    }

    func recordSuccessorConnected() {
        self.successorConnected = true
        self.events.append("successor-connected")
    }

    func state() -> (started: Bool, cancelled: Bool, invalidated: Bool, successorConnected: Bool) {
        (self.invokeStarted, self.invokeCancelled, self.routeInvalidated, self.successorConnected)
    }

    func recordedEvents() -> [String] {
        self.events
    }
}

private actor CoordinatorDrainSnapshotProbe {
    private var captured = false

    func recordCapture() {
        self.captured = true
    }

    func hasCaptured() -> Bool {
        self.captured
    }
}

private actor CoordinatorNodeHostWorkerProbe: MacNodeHostWorking {
    private var stopCount = 0
    private let stopGate = AsyncTestGate()
    private var blockedRouteClearAuthorityGeneration: UInt64?
    private let routeClearEnteredGate = AsyncTestGate()
    private let routeClearReleaseGate = AsyncTestGate()

    func start(launch _: MacNodeHostWorkerLaunch) async throws -> MacNodeHostManifest {
        MacNodeHostManifest(version: "test", caps: [], commands: [], pathEnv: "/usr/bin:/bin")
    }

    func supports(_: String) async -> Bool {
        false
    }

    func invoke(_ request: BridgeInvokeRequest) async -> BridgeInvokeResponse {
        BridgeInvokeResponse(id: request.id, ok: false)
    }

    func handleInput(invokeId _: String, seq _: Int, payloadJSON _: String) async {}
    func cancel(invokeId _: String) async {}

    func setRoute(_ route: GatewayNodeSessionRoute?, authorityGeneration: UInt64) async -> Bool {
        guard route == nil,
              authorityGeneration == self.blockedRouteClearAuthorityGeneration
        else { return true }
        self.routeClearEnteredGate.open()
        await self.routeClearReleaseGate.wait()
        return true
    }

    func blockRouteClear(_ authorityGeneration: UInt64) {
        self.blockedRouteClearAuthorityGeneration = authorityGeneration
    }

    func waitUntilBlockedRouteClearEntered() async {
        await self.routeClearEnteredGate.wait()
    }

    func releaseBlockedRouteClear() {
        self.routeClearReleaseGate.open()
    }

    func publishInventory(ifCurrentRoute _: GatewayNodeSessionRoute) async {}
    func stop() async {
        self.stopCount += 1
        self.stopGate.open()
    }

    func waitUntilStopped() async {
        await self.stopGate.wait()
    }

    func stops() -> Int {
        self.stopCount
    }
}

private actor CoordinatorFailingStartWorkerProbe: MacNodeHostWorking {
    static let failureReason = "worker exited with status exited(1)"
    static let failureDiagnostic = "[openclaw] state database uses newer schema version 10"
    private var startCalls = 0

    func start(launch _: MacNodeHostWorkerLaunch) async throws -> MacNodeHostManifest {
        self.startCalls += 1
        throw MacNodeHostWorker.WorkerError.unavailable(
            reason: Self.failureReason,
            diagnostic: Self.failureDiagnostic)
    }

    func supports(_: String) async -> Bool {
        false
    }

    func invoke(_ request: BridgeInvokeRequest) async -> BridgeInvokeResponse {
        BridgeInvokeResponse(id: request.id, ok: false)
    }

    func handleInput(invokeId _: String, seq _: Int, payloadJSON _: String) async {}
    func cancel(invokeId _: String) async {}
    func setRoute(_: GatewayNodeSessionRoute?, authorityGeneration _: UInt64) async -> Bool {
        true
    }

    func publishInventory(ifCurrentRoute _: GatewayNodeSessionRoute) async {}
    func stop() async {}

    func startCallCount() -> Int {
        self.startCalls
    }
}

private final class CoordinatorRetrySleeperProbe: @unchecked Sendable {
    private let entered = AsyncTestGate()
    private let releaseGate = AsyncTestGate()

    func sleep(_: UInt64) async throws {
        self.entered.open()
        await self.releaseGate.wait()
        try Task.checkCancellation()
    }

    func waitUntilEntered() async {
        await self.entered.wait()
    }

    func release() {
        self.releaseGate.open()
    }
}

private struct CoordinatorWaitTimeout: Error, CustomStringConvertible {
    let operation: String

    var description: String {
        "timed out waiting for \(self.operation)"
    }
}

struct MacNodeModeCoordinatorTests {
    private func waitUntil(
        _ description: String,
        timeout: Duration = .seconds(2),
        condition: @escaping @Sendable () async -> Bool) async throws
    {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: timeout)
        while clock.now < deadline {
            if await condition() {
                return
            }
            // Some callers run on MainActor; a real suspension lets the
            // notification task make progress instead of polling it out.
            try await Task.sleep(for: .milliseconds(10))
        }
        throw CoordinatorWaitTimeout(operation: description)
    }

    @MainActor
    private func cleanupRevocationTest(
        lifecycleInvalidationGate: AsyncTestGate,
        worker: CoordinatorNodeHostWorkerProbe,
        successor: Task<Void, Error>?,
        gateway: GatewayNodeSession,
        coordinator: MacNodeModeCoordinator) async
    {
        lifecycleInvalidationGate.open()
        await worker.releaseBlockedRouteClear()
        successor?.cancel()
        if let successor {
            _ = await successor.result
        }
        await gateway.disconnect()
        await coordinator.stopAndWait()
    }

    @Test func `stale endpoint attempt is rejected after a suspended permission query`() {
        #expect(MacNodeModeCoordinator.endpointAttemptIsCurrent(
            capturedGeneration: 7,
            currentGeneration: 7))
        #expect(!MacNodeModeCoordinator.endpointAttemptIsCurrent(
            capturedGeneration: 7,
            currentGeneration: 8))
    }

    @Test @MainActor func `config and CLI changes restart startup scoped node host worker`() async {
        let worker = CoordinatorNodeHostWorkerProbe()
        let session = GatewayNodeSession()
        let coordinator = MacNodeModeCoordinator(
            session: session,
            runtime: MacNodeRuntime(nodeHostWorker: worker),
            nodeHostWorker: worker)

        await coordinator.handleNodeHostConfigurationChangeForTesting()
        #expect(await worker.stops() == 1)

        await coordinator.handleNodeHostConfigurationChangeForTesting()
        #expect(await worker.stops() == 2)

        await coordinator.stopAndWait()
    }

    @Test @MainActor func `ordinary gateway reconnect preserves the startup scoped worker`() async {
        let worker = CoordinatorNodeHostWorkerProbe()
        let session = GatewayNodeSession()
        let coordinator = MacNodeModeCoordinator(
            session: session,
            runtime: MacNodeRuntime(nodeHostWorker: worker),
            nodeHostWorker: worker)

        coordinator.enqueueRouteInvalidationForTesting()
        await coordinator.waitForRouteInvalidationForTesting()

        #expect(await worker.stops() == 0)
        await coordinator.stopAndWait()
    }

    @Test @MainActor func `terminal stop owns cleanup after coordinator release`() async {
        let worker = CoordinatorNodeHostWorkerProbe()
        let session = GatewayNodeSession()
        var coordinator: MacNodeModeCoordinator? = MacNodeModeCoordinator(
            session: session,
            runtime: MacNodeRuntime(nodeHostWorker: worker),
            nodeHostWorker: worker)

        // The MainActor task cannot begin until this test suspends below.
        coordinator?.stop()
        coordinator?.stop()
        coordinator = nil
        await worker.waitUntilStopped()

        #expect(await worker.stops() == 1)
    }

    @Test @MainActor func `terminal worker failure is reported instead of scheduling another restart`() async throws {
        let worker = CoordinatorNodeHostWorkerProbe()
        let session = GatewayNodeSession()
        let notificationCenter = NotificationCenter()
        let coordinator = MacNodeModeCoordinator(
            session: session,
            runtime: MacNodeRuntime(nodeHostWorker: worker),
            nodeHostWorker: worker,
            notificationCenter: notificationCenter,
            nodeHostWorkerRetryPolicy: MacNodeHostWorkerRetryPolicy(maximumRetryCount: 0))

        try coordinator.prepareNodeHostWorkerRetryForTesting(
            command: ["/usr/local/bin/openclaw", "node", "worker"])
        await confirmation("terminal worker failure") { confirmed in
            let observer = notificationCenter.addObserver(
                forName: .openclawNodeHostWorkerRetryExhausted,
                object: coordinator,
                queue: nil)
            { notification in
                #expect(notification.userInfo?["unexpectedExitCount"] as? Int == 1)
                confirmed()
            }
            coordinator.handleNodeHostWorkerFailureForTesting()
            notificationCenter.removeObserver(observer)
        }
        await coordinator.waitForRouteInvalidationForTesting()
        #expect(await worker.stops() == 0)
    }

    @Test @MainActor func `worker cannot restart before its crash backoff expires`() async throws {
        let worker = CoordinatorNodeHostWorkerProbe()
        let session = GatewayNodeSession()
        let sleeper = CoordinatorRetrySleeperProbe()
        let coordinator = MacNodeModeCoordinator(
            session: session,
            runtime: MacNodeRuntime(nodeHostWorker: worker),
            nodeHostWorker: worker,
            observeNotifications: false,
            nodeHostWorkerRetrySleep: { try await sleeper.sleep($0) },
            nodeHostWorkerRetryPolicy: MacNodeHostWorkerRetryPolicy(
                maximumRetryCount: 1,
                initialDelayNanoseconds: 50_000_000,
                maximumDelayNanoseconds: 50_000_000))
        let command = ["/usr/local/bin/openclaw", "node", "worker"]
        defer { sleeper.release() }

        try coordinator.prepareNodeHostWorkerRetryForTesting(command: command)
        coordinator.handleNodeHostWorkerFailureForTesting()
        await sleeper.waitUntilEntered()
        #expect(throws: MacNodeHostWorkerRetryPolicy.RetryBackoffPending.self) {
            try coordinator.prepareNodeHostWorkerRetryForTesting(command: command)
        }

        sleeper.release()
        await coordinator.waitForNodeHostWorkerRetryForTesting()
        try coordinator.prepareNodeHostWorkerRetryForTesting(command: command)
        await coordinator.stopAndWait()
    }

    @Test @MainActor func `queued failure from replaced worker does not penalize replacement`() async throws {
        let worker = CoordinatorNodeHostWorkerProbe()
        let session = GatewayNodeSession()
        let coordinator = MacNodeModeCoordinator(
            session: session,
            runtime: MacNodeRuntime(nodeHostWorker: worker),
            nodeHostWorker: worker)
        let command = ["/usr/local/bin/openclaw", "node", "worker"]

        try coordinator.prepareNodeHostWorkerRetryForTesting(command: command)
        await coordinator.handleNodeHostConfigurationChangeForTesting()
        try coordinator.prepareNodeHostWorkerRetryForTesting(command: command)

        // Generation zero belongs to the replaced process. Handle it only after
        // the successor input is installed so the ordering is deterministic.
        coordinator.handleNodeHostWorkerFailureForTesting(configurationGeneration: .zero)

        try coordinator.prepareNodeHostWorkerRetryForTesting(command: command)
        await coordinator.stopAndWait()
    }

    // Regression: an exhausted node-host worker must degrade the connect to
    // native capabilities with a visible reason. Before this, retry exhaustion
    // (and any startup-scoped worker failure) aborted the whole connection
    // attempt, so the node channel never dialed and the operator saw nothing.
    @Test @MainActor func `worker retry exhaustion degrades the node connect instead of blocking it`() async throws {
        let worker = CoordinatorFailingStartWorkerProbe()
        let session = GatewayNodeSession()
        let coordinator = MacNodeModeCoordinator(
            session: session,
            runtime: MacNodeRuntime(nodeHostWorker: worker),
            nodeHostWorker: worker,
            notificationCenter: NotificationCenter(),
            nodeHostWorkerRetryPolicy: MacNodeHostWorkerRetryPolicy(maximumRetryCount: 0))

        try coordinator.prepareNodeHostWorkerRetryForTesting(
            command: ["/usr/local/bin/openclaw", "node", "worker"])
        let initialFailure = try await coordinator.resolveWorkerManifestForConnectionForTesting()
        #expect(initialFailure.unavailable?.reason == CoordinatorFailingStartWorkerProbe.failureReason)
        #expect(initialFailure.unavailable?.diagnostic == CoordinatorFailingStartWorkerProbe.failureDiagnostic)

        coordinator.handleNodeHostWorkerFailureForTesting()
        await coordinator.waitForRouteInvalidationForTesting()

        let resolved = try await coordinator.resolveWorkerManifestForConnectionForTesting()
        #expect(resolved.manifest == nil)
        #expect(resolved.unavailable?.reason.contains("unexpected exits") == true)
        #expect(resolved.unavailable?.reason.contains(CoordinatorFailingStartWorkerProbe.failureReason) == true)
        #expect(resolved.unavailable?.diagnostic == initialFailure.unavailable?.diagnostic)
        // The exhausted budget must also stop worker respawn attempts.
        #expect(await worker.startCallCount() == 1)
        await coordinator.stopAndWait()
    }

    @Test func `node channel states map to operator status lines`() {
        #expect(MacNodeChannelState.idle.operatorStatusLine == nil)
        #expect(MacNodeChannelState.connected(workerUnavailableReason: nil).operatorStatusLine == nil)

        let degraded = MacNodeChannelState
            .connected(workerUnavailableReason: "worker exited: schema mismatch")
            .operatorStatusLine
        #expect(degraded?.label == "Mac node degraded — worker exited: schema mismatch")
        #expect(degraded?.diagnostic == nil)
        #expect(degraded?.isDegraded == true)

        let unavailable = MacNodeChannelState
            .unavailable(reason: "state database uses newer schema version 10\nTry: openclaw doctor")
            .operatorStatusLine
        #expect(unavailable?.label == "Mac node unavailable — state database uses newer schema version 10")
        #expect(unavailable?.diagnostic == nil)
        #expect(unavailable?.isDegraded == false)
    }

    @Test func `worker stderr never becomes part of the operator status headline`() throws {
        let diagnostic = "[openclaw] bootstrap failed: state database uses a newer schema"
        let reason = "worker exited with status exited(1)"
        let states: [MacNodeChannelState] = [
            .unavailable(reason: reason, diagnostic: diagnostic),
            .connected(workerUnavailableReason: reason, diagnostic: diagnostic),
        ]

        for state in states {
            let line = try #require(state.operatorStatusLine)
            #expect(line.label.contains(reason))
            #expect(!line.label.contains(diagnostic))
            #expect(line.diagnostic == diagnostic)
        }
    }

    @Test func `operator diagnostics preserve complete lines within their display budget`() throws {
        let inputLines = (0..<10).map { index in
            "[openclaw] line \(index): " + String(repeating: "bootstrap failure details ", count: 5)
        }
        let input = inputLines.joined(separator: "\n")
        let line = try #require(MacNodeChannelState.unavailable(
            reason: "worker exited",
            diagnostic: input).operatorStatusLine)
        let diagnostic = try #require(line.diagnostic)
        let completeLines = String(diagnostic.dropLast()).split(separator: "\n").map(String.init)

        #expect(diagnostic.count <= 360)
        #expect(completeLines.count <= 4)
        #expect(diagnostic.hasSuffix("…"))
        #expect(completeLines.elementsEqual(inputLines.prefix(completeLines.count)))

        let longLine = Array(repeating: "bootstrap", count: 100).joined(separator: " ")
        let singleLine = try #require(MacNodeChannelState.unavailable(
            reason: "worker exited",
            diagnostic: longLine).operatorStatusLine?.diagnostic)

        #expect(singleLine.count <= 360)
        #expect(singleLine.hasSuffix("…"))
        #expect(String(singleLine.dropLast()).split(separator: " ").allSatisfy { $0 == "bootstrap" })
    }

    @Test func `paused node state requires route disconnect`() {
        #expect(MacNodeModeCoordinator.pausedStateRequiresDisconnect(true))
        #expect(!MacNodeModeCoordinator.pausedStateRequiresDisconnect(false))
        #expect(MacNodeModeCoordinator.controlTransitionRequiresRouteInvalidation(
            previousPaused: false,
            nextPaused: true,
            previousComputerControlEnabled: true,
            nextComputerControlEnabled: true))
        #expect(MacNodeModeCoordinator.controlTransitionRequiresRouteInvalidation(
            previousPaused: false,
            nextPaused: false,
            previousComputerControlEnabled: true,
            nextComputerControlEnabled: false))
        #expect(!MacNodeModeCoordinator.controlTransitionRequiresRouteInvalidation(
            previousPaused: false,
            nextPaused: false,
            previousComputerControlEnabled: true,
            nextComputerControlEnabled: true))
        #expect(MacNodeModeCoordinator.controlTransitionRequiresRouteInvalidation(
            previousPaused: false,
            nextPaused: false,
            previousComputerControlEnabled: true,
            nextComputerControlEnabled: true,
            previousComputerControlProvider: .peekaboo,
            nextComputerControlProvider: .cua))
    }

    @Test func `first endpoint snapshot rejects a stale captured endpoint`() throws {
        let first = try GatewayConnection.EndpointSnapshot(
            config: GatewayConnection.Config(
                url: #require(URL(string: "wss://first.example.invalid")),
                token: "first-token",
                password: nil),
            routeAuthority: nil,
            revision: 1)
        let replacement = try GatewayEndpointState.ready(
            mode: .remote,
            url: #require(URL(string: "wss://second.example.invalid")),
            token: "second-token",
            password: nil,
            routeRevision: 2)

        #expect(!MacNodeModeCoordinator.endpointState(replacement, matches: first))
    }

    @Test func `stop pause and endpoint changes revoke final connect admission`() throws {
        let first = try GatewayConnection.EndpointSnapshot(
            config: GatewayConnection.Config(
                url: #require(URL(string: "wss://first.example.invalid")),
                token: "token",
                password: nil),
            routeAuthority: nil,
            revision: 1)
        let replacement = try GatewayConnection.EndpointSnapshot(
            config: GatewayConnection.Config(
                url: #require(URL(string: "wss://second.example.invalid")),
                token: "token",
                password: nil),
            routeAuthority: nil,
            revision: 2)

        #expect(MacNodeModeCoordinator.endpointAttemptCanConnect(
            capturedGeneration: 4,
            currentGeneration: 4,
            isCancelled: false,
            isPaused: false,
            capturedEndpoint: first,
            currentEndpoint: first))
        #expect(!MacNodeModeCoordinator.endpointAttemptCanConnect(
            capturedGeneration: 4,
            currentGeneration: 5,
            isCancelled: false,
            isPaused: false,
            capturedEndpoint: first,
            currentEndpoint: first))
        #expect(!MacNodeModeCoordinator.endpointAttemptCanConnect(
            capturedGeneration: 4,
            currentGeneration: 4,
            isCancelled: true,
            isPaused: false,
            capturedEndpoint: first,
            currentEndpoint: first))
        #expect(!MacNodeModeCoordinator.endpointAttemptCanConnect(
            capturedGeneration: 4,
            currentGeneration: 4,
            isCancelled: false,
            isPaused: true,
            capturedEndpoint: first,
            currentEndpoint: first))
        #expect(!MacNodeModeCoordinator.endpointAttemptCanConnect(
            capturedGeneration: 4,
            currentGeneration: 4,
            isCancelled: false,
            isPaused: false,
            capturedEndpoint: first,
            currentEndpoint: replacement))
    }

    @Test func `invoke admission stays bound to installed route authority`() {
        #expect(MacNodeModeCoordinator.routeAuthorityAllowsInvoke(
            capturedRouteAuthorityGeneration: 9,
            currentRouteAuthorityGeneration: 9,
            completedRouteAuthorityGeneration: 9,
            isPaused: false))
        #expect(!MacNodeModeCoordinator.routeAuthorityAllowsInvoke(
            capturedRouteAuthorityGeneration: 9,
            currentRouteAuthorityGeneration: 10,
            completedRouteAuthorityGeneration: 9,
            isPaused: false))
        #expect(!MacNodeModeCoordinator.routeAuthorityAllowsInvoke(
            capturedRouteAuthorityGeneration: 9,
            currentRouteAuthorityGeneration: 9,
            completedRouteAuthorityGeneration: 8,
            isPaused: false))
        #expect(!MacNodeModeCoordinator.routeAuthorityAllowsInvoke(
            capturedRouteAuthorityGeneration: 9,
            currentRouteAuthorityGeneration: 9,
            completedRouteAuthorityGeneration: 9,
            isPaused: true))
    }

    @Test @MainActor func `revocation finishes before successor admission`() async throws {
        let webSocketSession = GatewayTestWebSocketSession()
        let gateway = GatewayNodeSession()
        let lifecycleInvalidationGate = AsyncTestGate()
        let lifecycle = CoordinatorInvokeLifecycleProbe(
            routeInvalidationGate: lifecycleInvalidationGate)
        let drainSnapshot = CoordinatorDrainSnapshotProbe()
        let worker = CoordinatorNodeHostWorkerProbe()
        let runtime = MacNodeRuntime(computerControlEnabled: { true })
        let coordinator = MacNodeModeCoordinator(
            session: gateway,
            runtime: runtime,
            nodeHostWorker: worker,
            initialPaused: false,
            initialComputerControlEnabled: true)
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
        var successor: Task<Void, Error>?

        do {
            try await gateway.connect(
                url: #require(URL(string: "ws://first.example.invalid")),
                token: nil,
                bootstrapToken: nil,
                password: nil,
                connectOptions: options,
                sessionBox: WebSocketSessionBox(session: webSocketSession),
                onConnected: {},
                onDisconnected: { _ in },
                onInvoke: { request in await lifecycle.invoke(request) },
                onRouteInvalidated: { await lifecycle.recordInvalidation() })
            let task = try #require(webSocketSession.latestTask())
            while !task.hasPendingReceiveHandler() {
                await Task.yield()
            }
            let invokeEvent = try JSONSerialization.data(withJSONObject: [
                "type": "event",
                "event": "node.invoke.request",
                "payload": [
                    "id": "in-flight-computer",
                    "nodeId": "test-node",
                    "command": "computer.act",
                    "paramsJSON": "{}",
                    "timeoutMs": 0,
                ],
            ])
            task.emitReceiveSuccessOnce(.data(invokeEvent))
            try await self.waitUntil("computer invoke start") {
                await lifecycle.state().started
            }

            let originalRoute = try #require(await gateway.currentRoute())
            let generationsBeforeRefresh = coordinator.generationsForTesting()
            coordinator.refreshForTesting(
                isPaused: false,
                computerControlEnabled: true)
            for _ in 0..<20 {
                await Task.yield()
            }
            let stateAfterOrdinaryRefresh = await lifecycle.state()
            let generationsAfterOrdinaryRefresh = coordinator.generationsForTesting()
            #expect(await gateway.currentRoute() == originalRoute)
            #expect(!stateAfterOrdinaryRefresh.cancelled)
            #expect(!stateAfterOrdinaryRefresh.invalidated)
            #expect(generationsAfterOrdinaryRefresh.endpointAttempt == generationsBeforeRefresh.endpointAttempt + 1)
            #expect(generationsAfterOrdinaryRefresh.routeAuthority == generationsBeforeRefresh.routeAuthority)
            #expect(coordinator.routeAuthorityAllowsInvokeForTesting(
                generationsBeforeRefresh.routeAuthority,
                isPaused: false))

            coordinator.refreshForTesting(
                isPaused: true,
                computerControlEnabled: true)
            let generationsAfterPause = coordinator.generationsForTesting()
            #expect(generationsAfterPause.routeAuthority == generationsBeforeRefresh.routeAuthority + 1)
            #expect(!coordinator.routeAuthorityAllowsInvokeForTesting(
                generationsBeforeRefresh.routeAuthority,
                isPaused: true))
            try await self.waitUntil("route invalidation start") {
                await lifecycle.state().invalidated
            }

            let successorURL = try #require(URL(string: "ws://successor.example.invalid"))
            let successorTask = Task {
                await coordinator.waitForRouteInvalidationForTesting(
                    onPendingSnapshot: { await drainSnapshot.recordCapture() })
                try await gateway.connect(
                    url: successorURL,
                    token: nil,
                    bootstrapToken: nil,
                    password: nil,
                    connectOptions: options,
                    sessionBox: WebSocketSessionBox(session: webSocketSession),
                    onConnected: { await lifecycle.recordSuccessorConnected() },
                    onDisconnected: { _ in },
                    onInvoke: { request in BridgeInvokeResponse(id: request.id, ok: true) })
            }
            successor = successorTask
            try await self.waitUntil("successor captured first invalidation") {
                await drainSnapshot.hasCaptured()
            }
            coordinator.enqueueRouteInvalidationForTesting()
            let generationsAfterSecondRevocation = coordinator.generationsForTesting()
            #expect(generationsAfterSecondRevocation.routeAuthority == generationsBeforeRefresh.routeAuthority + 2)
            #expect(generationsAfterSecondRevocation.completedRouteAuthority == generationsBeforeRefresh.routeAuthority)

            await worker.blockRouteClear(generationsAfterSecondRevocation.routeAuthority)
            lifecycleInvalidationGate.open()
            await worker.waitUntilBlockedRouteClearEntered()
            let stateWhileSecondRevocationBlocked = await lifecycle.state()
            #expect(webSocketSession.snapshotMakeCount() == 1)
            #expect(!stateWhileSecondRevocationBlocked.successorConnected)
            let generationsWhileSecondRevocationBlocked = coordinator.generationsForTesting()
            #expect(generationsWhileSecondRevocationBlocked.completedRouteAuthority ==
                generationsBeforeRefresh.routeAuthority + 1)
            #expect(!coordinator.routeAuthorityAllowsInvokeForTesting(
                generationsAfterSecondRevocation.routeAuthority,
                isPaused: false))

            await worker.releaseBlockedRouteClear()
            try await successorTask.value

            let finalState = await lifecycle.state()
            #expect(finalState.cancelled)
            #expect(finalState.invalidated)
            #expect(finalState.successorConnected)
            #expect(webSocketSession.snapshotMakeCount() == 2)
            #expect(await lifecycle.recordedEvents() == [
                "invalidation-started",
                "invalidation-finished",
                "successor-connected",
            ])
            #expect(await gateway.currentRoute() != nil)
            let finalGenerations = coordinator.generationsForTesting()
            #expect(finalGenerations.completedRouteAuthority == finalGenerations.routeAuthority)
        } catch {
            await self.cleanupRevocationTest(
                lifecycleInvalidationGate: lifecycleInvalidationGate,
                worker: worker,
                successor: successor,
                gateway: gateway,
                coordinator: coordinator)
            throw error
        }
        await self.cleanupRevocationTest(
            lifecycleInvalidationGate: lifecycleInvalidationGate,
            worker: worker,
            successor: successor,
            gateway: gateway,
            coordinator: coordinator)
    }

    @Test @MainActor func `effective endpoint transitions require route teardown`() throws {
        let firstURL = try #require(URL(string: "wss://first.example.invalid"))
        let secondURL = try #require(URL(string: "wss://second.example.invalid"))
        let first = GatewayEndpointState.ready(
            mode: .remote,
            url: firstURL,
            token: "token",
            password: nil)

        #expect(!MacNodeModeCoordinator.endpointTransitionRequiresDisconnect(from: first, to: first))
        #expect(MacNodeModeCoordinator.endpointTransitionRequiresDisconnect(
            from: first,
            to: .ready(mode: .remote, url: secondURL, token: "token", password: nil)))
        #expect(MacNodeModeCoordinator.endpointTransitionRequiresDisconnect(
            from: first,
            to: .ready(mode: .remote, url: firstURL, token: "replacement", password: nil)))
        #expect(MacNodeModeCoordinator.endpointTransitionRequiresDisconnect(
            from: first,
            to: .unavailable(mode: .remote, reason: "offline")))
        #expect(MacNodeModeCoordinator.endpointTransitionRequiresDisconnect(
            from: .connecting(mode: .remote, detail: "connecting"),
            to: first))
        #expect(!MacNodeModeCoordinator.endpointTransitionRequiresDisconnect(
            from: .connecting(mode: .remote, detail: "connecting"),
            to: .unavailable(mode: .remote, reason: "offline")))
    }

    @Test @MainActor func `fresh node uses durable dedicated identity for local auto approval`() throws {
        let defaults = try #require(UserDefaults(suiteName: "MacNodeModeCoordinatorTests.fresh.\(UUID().uuidString)"))

        #expect(MacNodeModeCoordinator.resolveNodeIdentityProfile(
            defaults: defaults,
            isExistingInstallation: false) == .node)
        #expect(MacNodeModeCoordinator.resolveNodeIdentityProfile(
            defaults: defaults,
            isExistingInstallation: true) == .node)
    }

    @Test @MainActor func `upgraded node durably preserves its shipped primary identity`() throws {
        let defaults = try #require(UserDefaults(suiteName: "MacNodeModeCoordinatorTests.upgrade.\(UUID().uuidString)"))

        #expect(MacNodeModeCoordinator.resolveNodeIdentityProfile(
            defaults: defaults,
            isExistingInstallation: true) == .primary)
        #expect(MacNodeModeCoordinator.resolveNodeIdentityProfile(
            defaults: defaults,
            isExistingInstallation: false) == .primary)
    }

    @Test func `native manifest excludes CLI-owned node commands`() {
        let caps = MacNodeModeCoordinator.resolvedCaps(
            browserControlEnabled: true,
            cameraEnabled: false,
            computerControlEnabled: false,
            locationMode: .off,
            connectionMode: .remote)
        let commands = MacNodeModeCoordinator.resolvedCommands(caps: caps)

        #expect(!caps.contains(OpenClawCapability.browser.rawValue))
        #expect(!commands.contains(OpenClawBrowserCommand.proxy.rawValue))
        #expect(commands.filter { $0.hasPrefix("canvas.") } == [
            OpenClawCanvasCommand.present.rawValue,
            OpenClawCanvasCommand.hide.rawValue,
            OpenClawCanvasCommand.navigate.rawValue,
        ])
        #expect(commands.contains(OpenClawSystemCommand.notify.rawValue))
        #expect(!commands.contains(OpenClawFileSystemCommand.listDir.rawValue))
        #expect(!commands.contains(OpenClawSystemCommand.run.rawValue))
    }

    @Test func `node permission metadata omits unknown authorization state`() {
        let permissions = MacNodeModeCoordinator.advertisedPermissions([
            .appleScript: .unknown,
            .accessibility: .granted,
            .screenRecording: .notGranted,
        ])

        #expect(permissions == [
            Capability.accessibility.rawValue: true,
            Capability.screenRecording.rawValue: false,
        ])
    }

    @Test func `local native manifest leaves browser proxy to the CLI worker`() {
        let caps = MacNodeModeCoordinator.resolvedCaps(
            browserControlEnabled: true,
            cameraEnabled: false,
            computerControlEnabled: false,
            locationMode: .off,
            connectionMode: .local)
        let commands = MacNodeModeCoordinator.resolvedCommands(caps: caps)

        #expect(!caps.contains(OpenClawCapability.browser.rawValue))
        #expect(!commands.contains(OpenClawBrowserCommand.proxy.rawValue))
    }

    @Test func `local mode omits native session catalogs`() {
        let caps = MacNodeModeCoordinator.resolvedCaps(
            browserControlEnabled: false,
            cameraEnabled: false,
            computerControlEnabled: false,
            locationMode: .off,
            connectionMode: .local,
            codexThreadCatalogEnabled: true,
            claudeSessionCatalogEnabled: true)
        let commands = MacNodeModeCoordinator.resolvedCommands(caps: caps)

        #expect(!caps.contains(MacNodeCodexThreadCatalogContract.capability))
        #expect(!commands.contains(MacNodeCodexThreadCatalogContract.listCommand))
        #expect(!commands.contains(MacNodeCodexThreadCatalogContract.turnsCommand))
        #expect(!caps.contains(MacNodeClaudeSessionCatalogContract.capability))
        #expect(!commands.contains(MacNodeClaudeSessionCatalogContract.listCommand))
        #expect(!commands.contains(MacNodeClaudeSessionCatalogContract.readCommand))
    }

    @Test func `remote mode advertises native session catalogs`() {
        let caps = MacNodeModeCoordinator.resolvedCaps(
            browserControlEnabled: false,
            cameraEnabled: false,
            computerControlEnabled: false,
            locationMode: .off,
            connectionMode: .remote,
            codexThreadCatalogEnabled: true,
            claudeSessionCatalogEnabled: true)
        let commands = MacNodeModeCoordinator.resolvedCommands(caps: caps)

        #expect(caps.contains(MacNodeCodexThreadCatalogContract.capability))
        #expect(commands.contains(MacNodeCodexThreadCatalogContract.listCommand))
        #expect(commands.contains(MacNodeCodexThreadCatalogContract.turnsCommand))
        #expect(MacNodeModeCoordinator.routeSnapshotAllowsCodexCatalogInvoke(
            command: MacNodeCodexThreadCatalogContract.listCommand,
            catalogAdvertised: true))
        #expect(!MacNodeModeCoordinator.routeSnapshotAllowsCodexCatalogInvoke(
            command: MacNodeCodexThreadCatalogContract.listCommand,
            catalogAdvertised: false))
        #expect(!MacNodeModeCoordinator.routeSnapshotAllowsCodexCatalogInvoke(
            command: MacNodeCodexThreadCatalogContract.turnsCommand,
            catalogAdvertised: false))
        #expect(MacNodeModeCoordinator.routeSnapshotAllowsCodexCatalogInvoke(
            command: OpenClawSystemCommand.notify.rawValue,
            catalogAdvertised: false))
        #expect(caps.contains(MacNodeClaudeSessionCatalogContract.capability))
        #expect(commands.contains(MacNodeClaudeSessionCatalogContract.listCommand))
        #expect(commands.contains(MacNodeClaudeSessionCatalogContract.readCommand))
        #expect(MacNodeModeCoordinator.routeSnapshotAllowsClaudeCatalogInvoke(
            command: MacNodeClaudeSessionCatalogContract.listCommand,
            catalogAdvertised: true))
        #expect(!MacNodeModeCoordinator.routeSnapshotAllowsClaudeCatalogInvoke(
            command: MacNodeClaudeSessionCatalogContract.readCommand,
            catalogAdvertised: false))
        #expect(MacNodeModeCoordinator.routeSnapshotAllowsClaudeCatalogInvoke(
            command: OpenClawSystemCommand.notify.rawValue,
            catalogAdvertised: false))
    }

    @Test func `Codex supervision activation respects the plugin flag and global policy`() {
        let enabled: [String: Any] = [
            "plugins": [
                "entries": [
                    "codex": [
                        "enabled": true,
                        "config": ["supervision": ["enabled": true]],
                    ],
                ],
            ],
        ]
        #expect(OpenClawConfigFile.explicitlyEnabledPluginConfigFlag(
            "codex",
            path: ["supervision", "enabled"],
            root: enabled))
        #expect(MacNodeCodexThreadCatalog.shouldAdvertise(root: enabled))

        let enabledByConfigPath: [String: Any] = [
            "plugins": [
                "entries": [
                    "codex": [
                        "config": ["supervision": ["enabled": true]],
                    ],
                ],
            ],
        ]
        #expect(OpenClawConfigFile.configuredBundledPluginAllowed(
            "codex",
            root: enabledByConfigPath))
        #expect(MacNodeCodexThreadCatalog.shouldAdvertise(root: enabledByConfigPath))

        let numericPluginEnable: [String: Any] = [
            "plugins": [
                "entries": [
                    "codex": [
                        "enabled": NSNumber(value: 1),
                        "config": ["supervision": ["enabled": true]],
                    ],
                ],
            ],
        ]
        #expect(!OpenClawConfigFile.explicitlyEnabledPluginConfigFlag(
            "codex",
            path: ["supervision", "enabled"],
            root: numericPluginEnable))

        let numericNestedEnable: [String: Any] = [
            "plugins": [
                "entries": [
                    "codex": [
                        "enabled": true,
                        "config": ["supervision": ["enabled": NSNumber(value: 1)]],
                    ],
                ],
            ],
        ]
        #expect(!OpenClawConfigFile.explicitlyEnabledPluginConfigFlag(
            "codex",
            path: ["supervision", "enabled"],
            root: numericNestedEnable))

        let numericGlobalEnable: [String: Any] = [
            "plugins": [
                "enabled": NSNumber(value: 1),
                "entries": [
                    "codex": [
                        "enabled": true,
                        "config": ["supervision": ["enabled": true]],
                    ],
                ],
            ],
        ]
        #expect(!OpenClawConfigFile.explicitlyEnabledPluginConfigFlag(
            "codex",
            path: ["supervision", "enabled"],
            root: numericGlobalEnable))

        for transport in ["websocket", "unix"] {
            let unsupported: [String: Any] = [
                "plugins": [
                    "entries": [
                        "codex": [
                            "enabled": true,
                            "config": [
                                "supervision": ["enabled": true],
                                "appServer": ["transport": transport],
                            ],
                        ],
                    ],
                ],
            ]
            #expect(!MacNodeCodexThreadCatalog.shouldAdvertise(root: unsupported))
        }

        let agentHome: [String: Any] = [
            "plugins": [
                "entries": [
                    "codex": [
                        "enabled": true,
                        "config": [
                            "supervision": ["enabled": true],
                            "appServer": ["transport": "stdio", "homeScope": "agent"],
                        ],
                    ],
                ],
            ],
        ]
        #expect(!MacNodeCodexThreadCatalog.shouldAdvertise(root: agentHome))

        let supervisionDisabled: [String: Any] = [
            "plugins": [
                "entries": [
                    "codex": [
                        "enabled": true,
                        "config": ["supervision": ["enabled": false]],
                    ],
                ],
            ],
        ]
        #expect(!OpenClawConfigFile.explicitlyEnabledPluginConfigFlag(
            "codex",
            path: ["supervision", "enabled"],
            root: supervisionDisabled))

        let pluginDisabled: [String: Any] = [
            "plugins": [
                "entries": [
                    "codex": [
                        "enabled": false,
                        "config": ["supervision": ["enabled": true]],
                    ],
                ],
            ],
        ]
        #expect(!OpenClawConfigFile.configuredBundledPluginAllowed(
            "codex",
            root: pluginDisabled))
        #expect(!MacNodeCodexThreadCatalog.shouldAdvertise(root: pluginDisabled))

        let denied: [String: Any] = [
            "plugins": [
                "deny": ["codex"],
                "entries": [
                    "codex": [
                        "enabled": true,
                        "config": ["supervision": ["enabled": true]],
                    ],
                ],
            ],
        ]
        #expect(!OpenClawConfigFile.explicitlyEnabledPluginConfigFlag(
            "codex",
            path: ["supervision", "enabled"],
            root: denied))

        let omittedByAllowlist: [String: Any] = [
            "plugins": [
                "allow": ["other-plugin"],
                "entries": [
                    "codex": [
                        "enabled": true,
                        "config": ["supervision": ["enabled": true]],
                    ],
                ],
            ],
        ]
        #expect(!OpenClawConfigFile.configuredBundledPluginAllowed(
            "codex",
            root: omittedByAllowlist))
        #expect(!MacNodeCodexThreadCatalog.shouldAdvertise(root: omittedByAllowlist))

        let paddedIds: [String: Any] = [
            "plugins": [
                "allow": [" codex "],
                "entries": [
                    " codex ": [
                        "enabled": true,
                        "config": ["supervision": ["enabled": true]],
                    ],
                ],
            ],
        ]
        #expect(OpenClawConfigFile.explicitlyEnabledPluginConfigFlag(
            "codex",
            path: ["supervision", "enabled"],
            root: paddedIds))

        let paddedDeny: [String: Any] = [
            "plugins": [
                "deny": [" codex "],
                "entries": [
                    "codex": [
                        "enabled": true,
                        "config": ["supervision": ["enabled": true]],
                    ],
                ],
            ],
        ]
        #expect(!OpenClawConfigFile.explicitlyEnabledPluginConfigFlag(
            "codex",
            path: ["supervision", "enabled"],
            root: paddedDeny))

        let mixedCaseDeny: [String: Any] = [
            "plugins": [
                "deny": [" CoDeX "],
                "entries": [
                    "CODEX": [
                        "enabled": true,
                        "config": ["supervision": ["enabled": true]],
                    ],
                ],
            ],
        ]
        #expect(!OpenClawConfigFile.explicitlyEnabledPluginConfigFlag(
            "codex",
            path: ["supervision", "enabled"],
            root: mixedCaseDeny))
        #expect(!MacNodeCodexThreadCatalog.shouldAdvertise(root: mixedCaseDeny))

        let ambiguousEntryAliases: [String: Any] = [
            "plugins": [
                "entries": [
                    "CODEX": [
                        "enabled": true,
                        "config": ["supervision": ["enabled": true]],
                    ],
                    "codex": [
                        "enabled": false,
                        "config": ["supervision": ["enabled": false]],
                    ],
                ],
            ],
        ]
        #expect(OpenClawConfigFile.pluginEntry("codex", root: ambiguousEntryAliases) == nil)
        #expect(!OpenClawConfigFile.explicitlyEnabledPluginConfigFlag(
            "codex",
            path: ["supervision", "enabled"],
            root: ambiguousEntryAliases))
        #expect(!MacNodeCodexThreadCatalog.shouldAdvertise(root: ambiguousEntryAliases))
    }

    @Test func `computer control cap gates the computer.act command`() {
        let enabledCaps = MacNodeModeCoordinator.resolvedCaps(
            browserControlEnabled: false,
            cameraEnabled: false,
            computerControlEnabled: true,
            locationMode: .off,
            connectionMode: .local)
        let enabledCommands = MacNodeModeCoordinator.resolvedCommands(caps: enabledCaps)
        #expect(enabledCaps.contains(OpenClawCapability.computer.rawValue))
        #expect(enabledCommands.contains(OpenClawComputerCommand.act.rawValue))

        let disabledCaps = MacNodeModeCoordinator.resolvedCaps(
            browserControlEnabled: false,
            cameraEnabled: false,
            computerControlEnabled: false,
            locationMode: .off,
            connectionMode: .local)
        let disabledCommands = MacNodeModeCoordinator.resolvedCommands(caps: disabledCaps)
        #expect(!disabledCaps.contains(OpenClawCapability.computer.rawValue))
        #expect(!disabledCommands.contains(OpenClawComputerCommand.act.rawValue))
    }

    @Test func `camera cap gates capture and PTZ commands`() {
        let enabledCaps = MacNodeModeCoordinator.resolvedCaps(
            browserControlEnabled: false,
            cameraEnabled: true,
            computerControlEnabled: false,
            locationMode: .off,
            connectionMode: .local)
        let enabledCommands = MacNodeModeCoordinator.resolvedCommands(caps: enabledCaps)
        #expect(enabledCommands.contains(OpenClawCameraCommand.list.rawValue))
        #expect(enabledCommands.contains(OpenClawCameraCommand.ptzStatus.rawValue))
        #expect(enabledCommands.contains(OpenClawCameraCommand.ptzControl.rawValue))

        let disabledCaps = MacNodeModeCoordinator.resolvedCaps(
            browserControlEnabled: false,
            cameraEnabled: false,
            computerControlEnabled: false,
            locationMode: .off,
            connectionMode: .local)
        let disabledCommands = MacNodeModeCoordinator.resolvedCommands(caps: disabledCaps)
        #expect(!disabledCommands.contains(OpenClawCameraCommand.ptzStatus.rawValue))
        #expect(!disabledCommands.contains(OpenClawCameraCommand.ptzControl.rawValue))
    }

    @Test func `tls pin store key uses default wss port`() throws {
        let url = try #require(URL(string: "wss://gateway.example.ts.net"))
        #expect(GatewayTLSRoute.storeKey(for: url) == "gateway.example.ts.net:443")
    }

    @Test func `tls pin store key preserves the shipped host identity`() throws {
        let url = try #require(URL(string: "wss://Gateway.Example.ts.net"))

        #expect(GatewayTLSRoute.storeKey(for: url) == "Gateway.Example.ts.net:443")
    }

    @Test func `remote tls params prefer configured fingerprint over stored pin`() throws {
        let url = try #require(URL(string: "wss://gateway.example.com"))
        let root: [String: Any] = [
            "gateway": [
                "remote": [
                    "tlsFingerprint": "sha256:configured",
                ],
            ],
        ]

        let route = try #require(GatewayTLSRoute.resolve(
            url: url,
            connectionMode: .remote,
            configuredFingerprint: GatewayRemoteConfig.resolveTLSFingerprint(root: root),
            storedFingerprint: "stored"))

        #expect(route.params.expectedFingerprint == "sha256:configured")
        #expect(route.params.allowTOFU == false)
        #expect(route.params.storeKey == "gateway.example.com:443")
        #expect(!route.allowsTrustedPinReplacement)
    }

    @Test func `remote tls params allow first use only when no configured or stored pin exists`() throws {
        let url = try #require(URL(string: "wss://gateway.example.com"))

        let route = try #require(GatewayTLSRoute.resolve(
            url: url,
            connectionMode: .remote,
            configuredFingerprint: nil,
            storedFingerprint: nil))

        #expect(route.params.expectedFingerprint == nil)
        #expect(route.params.allowTOFU == true)
        #expect(route.allowsTrustedPinReplacement)
    }

    @Test func `local tls params ignore remote configured fingerprint`() throws {
        let url = try #require(URL(string: "wss://127.0.0.1:18789"))
        let root: [String: Any] = [
            "gateway": [
                "remote": [
                    "tlsFingerprint": "sha256:remote",
                ],
            ],
        ]

        let route = try #require(GatewayTLSRoute.resolve(
            url: url,
            connectionMode: .local,
            configuredFingerprint: GatewayRemoteConfig.resolveTLSFingerprint(root: root),
            storedFingerprint: "stored-local"))

        #expect(route.params.expectedFingerprint == "stored-local")
        #expect(route.params.allowTOFU == false)
        #expect(route.allowsTrustedPinReplacement)
    }

    @Test func `tls session cache reuses session box for unchanged params`() throws {
        let url = try #require(URL(string: "wss://gateway.example.com"))
        var cache = MacNodeGatewayTLSSessionCache()
        let route = try #require(GatewayTLSRoute.resolve(
            url: url,
            connectionMode: .remote,
            configuredFingerprint: "sha256:configured",
            storedFingerprint: "stored"))

        let first = cache.sessionBox(url: url, params: route.params)
        let second = cache.sessionBox(url: url, params: route.params)

        #expect(ObjectIdentifier(first.session) == ObjectIdentifier(second.session))
    }

    @Test func `tls session cache rebuilds session box when params change`() throws {
        let url = try #require(URL(string: "wss://gateway.example.com"))
        var cache = MacNodeGatewayTLSSessionCache()
        let firstRoute = try #require(GatewayTLSRoute.resolve(
            url: url,
            connectionMode: .remote,
            configuredFingerprint: "sha256:configured",
            storedFingerprint: "stored"))
        let secondRoute = try #require(GatewayTLSRoute.resolve(
            url: url,
            connectionMode: .remote,
            configuredFingerprint: "sha256:rotated",
            storedFingerprint: "stored"))

        let first = cache.sessionBox(url: url, params: firstRoute.params)
        let second = cache.sessionBox(url: url, params: secondRoute.params)

        #expect(ObjectIdentifier(first.session) != ObjectIdentifier(second.session))
    }

    @Test func `auto repairs trusted tailscale serve pin mismatch`() throws {
        let url = try #require(URL(string: "wss://gateway.example.ts.net"))
        let failure = GatewayTLSValidationFailure(
            kind: .pinMismatch,
            host: "gateway.example.ts.net",
            storeKey: "gateway.example.ts.net:443",
            expectedFingerprint: "old",
            observedFingerprint: "new",
            systemTrustOk: true,
            port: 443)
        let route = try #require(GatewayTLSRoute.resolve(
            url: url,
            connectionMode: .remote,
            configuredFingerprint: nil,
            storedFingerprint: "old"))

        #expect(route.permitsTrustedPinReplacement(url: url, failure: failure))
    }

    @Test func `does not auto repair a redirected TLS authority`() throws {
        let url = try #require(URL(string: "wss://gateway.example.ts.net"))
        let route = try #require(GatewayTLSRoute.resolve(
            url: url,
            connectionMode: .remote,
            configuredFingerprint: nil,
            storedFingerprint: "old"))
        let redirectedHost = GatewayTLSValidationFailure(
            kind: .pinMismatch,
            host: "redirect.example.ts.net",
            storeKey: "gateway.example.ts.net:443",
            expectedFingerprint: "old",
            observedFingerprint: "new",
            systemTrustOk: true,
            port: 443)
        let redirectedPort = GatewayTLSValidationFailure(
            kind: .pinMismatch,
            host: "gateway.example.ts.net",
            storeKey: "gateway.example.ts.net:443",
            expectedFingerprint: "old",
            observedFingerprint: "new",
            systemTrustOk: true,
            port: 8443)

        #expect(!route.permitsTrustedPinReplacement(url: url, failure: redirectedHost))
        #expect(!route.permitsTrustedPinReplacement(url: url, failure: redirectedPort))
    }

    @Test func `does not auto repair untrusted remote pin mismatch`() throws {
        let url = try #require(URL(string: "wss://gateway.example.com"))
        let failure = GatewayTLSValidationFailure(
            kind: .pinMismatch,
            host: "gateway.example.com",
            storeKey: "gateway.example.com:443",
            expectedFingerprint: "old",
            observedFingerprint: "new",
            systemTrustOk: true,
            port: 443)
        let route = try #require(GatewayTLSRoute.resolve(
            url: url,
            connectionMode: .remote,
            configuredFingerprint: nil,
            storedFingerprint: "old"))

        #expect(!route.permitsTrustedPinReplacement(url: url, failure: failure))
    }

    @Test func `does not auto repair configured pin mismatch`() throws {
        let url = try #require(URL(string: "wss://gateway.example.ts.net"))
        let failure = GatewayTLSValidationFailure(
            kind: .pinMismatch,
            host: "gateway.example.ts.net",
            storeKey: "gateway.example.ts.net:443",
            expectedFingerprint: "configured",
            observedFingerprint: "new",
            systemTrustOk: true,
            port: 443)
        let route = try #require(GatewayTLSRoute.resolve(
            url: url,
            connectionMode: .remote,
            configuredFingerprint: "configured",
            storedFingerprint: "old"))

        #expect(!route.permitsTrustedPinReplacement(url: url, failure: failure))
    }

    @Test func `stale repair cannot replace a newer stored pin`() async throws {
        try await withFakeGatewayTLSKeychain {
            let url = try #require(URL(string: "wss://gateway.example.ts.net"))
            let storeKey = "test-stale-repair"
            GatewayTLSStore.saveFingerprint("old", stableID: storeKey)
            let route = try #require(GatewayTLSRoute.resolve(
                url: url,
                connectionMode: .remote,
                configuredFingerprint: nil,
                storedFingerprint: "old",
                storeKey: storeKey))
            let firstFailure = GatewayTLSValidationFailure(
                kind: .pinMismatch,
                host: "gateway.example.ts.net",
                storeKey: storeKey,
                expectedFingerprint: "old",
                observedFingerprint: "new",
                systemTrustOk: true,
                port: 443)
            let staleFailure = GatewayTLSValidationFailure(
                kind: .pinMismatch,
                host: "gateway.example.ts.net",
                storeKey: storeKey,
                expectedFingerprint: "old",
                observedFingerprint: "stale",
                systemTrustOk: true,
                port: 443)

            let firstRepaired = await GatewayTLSRepairCoordinator.shared.repair(
                route: route,
                url: url,
                failure: firstFailure)
            let staleRepaired = await GatewayTLSRepairCoordinator.shared.repair(
                route: route,
                url: url,
                failure: staleFailure)

            #expect(firstRepaired)
            #expect(!staleRepaired)
            #expect(GatewayTLSStore.loadFingerprint(stableID: storeKey) == "new")
        }
    }

    @Test func `auto repairs trusted loopback pin mismatch`() throws {
        let url = try #require(URL(string: "wss://127.0.0.1:18789"))
        let failure = GatewayTLSValidationFailure(
            kind: .pinMismatch,
            host: "127.0.0.1",
            storeKey: "127.0.0.1:18789",
            expectedFingerprint: "old",
            observedFingerprint: "new",
            systemTrustOk: true,
            port: 18789)
        let route = try #require(GatewayTLSRoute.resolve(
            url: url,
            connectionMode: .remote,
            configuredFingerprint: nil,
            storedFingerprint: "old"))

        #expect(route.permitsTrustedPinReplacement(url: url, failure: failure))
    }

    @Test func `does not auto repair untrusted loopback pin mismatch`() throws {
        let url = try #require(URL(string: "wss://127.0.0.1:18789"))
        let failure = GatewayTLSValidationFailure(
            kind: .pinMismatch,
            host: "127.0.0.1",
            storeKey: "127.0.0.1:18789",
            expectedFingerprint: "old",
            observedFingerprint: "new",
            systemTrustOk: false,
            port: 18789)
        let route = try #require(GatewayTLSRoute.resolve(
            url: url,
            connectionMode: .remote,
            configuredFingerprint: nil,
            storedFingerprint: "old"))

        #expect(!route.permitsTrustedPinReplacement(url: url, failure: failure))
    }
}
