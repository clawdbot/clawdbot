import Foundation
import OpenClawIPC
import OpenClawKit
import Testing
@testable import OpenClaw

private actor CoordinatorInvokeLifecycleProbe {
    private var invokeStarted = false
    private var invokeCancelled = false
    private var routeInvalidated = false
    private var routeInvalidationReleased = false
    private var routeInvalidationContinuation: CheckedContinuation<Void, Never>?
    private var successorConnected = false
    private var events: [String] = []

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
        guard !self.routeInvalidationReleased else {
            self.events.append("invalidation-finished")
            return
        }
        await withCheckedContinuation { continuation in
            self.routeInvalidationContinuation = continuation
        }
        self.events.append("invalidation-finished")
    }

    func releaseInvalidation() {
        self.routeInvalidationReleased = true
        let continuation = self.routeInvalidationContinuation
        self.routeInvalidationContinuation = nil
        continuation?.resume()
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

private actor CoordinatorRouteInvalidationHookProbe {
    private var callCount = 0
    private var blockedCallContinuation: CheckedContinuation<Void, Never>?
    private var blockedCallReleased = false

    func run() async {
        self.callCount += 1
        guard self.callCount == 2, !self.blockedCallReleased else { return }
        await withCheckedContinuation { continuation in
            self.blockedCallContinuation = continuation
        }
    }

    func calls() -> Int {
        self.callCount
    }

    func releaseBlockedCall() {
        self.blockedCallReleased = true
        let continuation = self.blockedCallContinuation
        self.blockedCallContinuation = nil
        continuation?.resume()
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

    func start(command _: [String]) async throws -> MacNodeHostManifest {
        MacNodeHostManifest(version: "test", caps: [], commands: [], pathEnv: "/usr/bin:/bin")
    }

    func supports(_: String) async -> Bool { false }
    func invoke(_ request: BridgeInvokeRequest) async -> BridgeInvokeResponse {
        BridgeInvokeResponse(id: request.id, ok: false)
    }

    func handleInput(invokeId _: String, seq _: Int, payloadJSON _: String) async {}
    func cancel(invokeId _: String) async {}

    func setRoute(_: GatewayNodeSessionRoute?, authorityGeneration _: UInt64) async -> Bool { true }
    func publishInventory(ifCurrentRoute _: GatewayNodeSessionRoute) async {}
    func stop() async { self.stopCount += 1 }
    func stops() -> Int { self.stopCount }
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
        Issue.record("timed out waiting for \(description)")
    }

    @Test func `stale endpoint attempt is rejected after a suspended permission query`() {
        #expect(MacNodeModeCoordinator.endpointAttemptIsCurrent(
            capturedGeneration: 7,
            currentGeneration: 7))
        #expect(!MacNodeModeCoordinator.endpointAttemptIsCurrent(
            capturedGeneration: 7,
            currentGeneration: 8))
    }

    @Test @MainActor func `config and CLI changes restart startup scoped node host worker`() async throws {
        let worker = CoordinatorNodeHostWorkerProbe()
        let session = GatewayNodeSession()
        let notificationCenter = NotificationCenter()
        let coordinator = MacNodeModeCoordinator(
            session: session,
            runtime: MacNodeRuntime(nodeHostWorker: worker),
            nodeHostWorker: worker,
            notificationCenter: notificationCenter,
            observeNotifications: true)
        // The full parallel suite can keep MainActor busy for several seconds.
        let restartTimeout: Duration = .seconds(15)
        defer { withExtendedLifetime(coordinator) {} }

        notificationCenter.post(name: .openclawConfigDidChange, object: nil)

        try await self.waitUntil("node-host worker restart", timeout: restartTimeout) {
            await worker.stops() == 1
        }

        notificationCenter.post(name: .openclawCLIInstalled, object: nil)

        try await self.waitUntil("node-host worker restart", timeout: restartTimeout) {
            await worker.stops() == 2
        }
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
    }

    @Test func `first endpoint snapshot rejects a stale captured endpoint`() throws {
        let first = try GatewayConnection.Config(
            url: #require(URL(string: "wss://first.example.invalid")),
            token: "first-token",
            password: nil)
        let replacement = try GatewayEndpointState.ready(
            mode: .remote,
            url: #require(URL(string: "wss://second.example.invalid")),
            token: "second-token",
            password: nil)

        #expect(!MacNodeModeCoordinator.endpointState(replacement, matches: first))
    }

    @Test func `stop pause and config changes revoke final connect admission`() throws {
        let first = try GatewayConnection.Config(
            url: #require(URL(string: "wss://first.example.invalid")),
            token: "token",
            password: nil)
        let replacement = try GatewayConnection.Config(
            url: #require(URL(string: "wss://second.example.invalid")),
            token: "token",
            password: nil)

        #expect(MacNodeModeCoordinator.endpointAttemptCanConnect(
            capturedGeneration: 4,
            currentGeneration: 4,
            isCancelled: false,
            isPaused: false,
            capturedConfig: first,
            currentConfig: first))
        #expect(!MacNodeModeCoordinator.endpointAttemptCanConnect(
            capturedGeneration: 4,
            currentGeneration: 5,
            isCancelled: false,
            isPaused: false,
            capturedConfig: first,
            currentConfig: first))
        #expect(!MacNodeModeCoordinator.endpointAttemptCanConnect(
            capturedGeneration: 4,
            currentGeneration: 4,
            isCancelled: true,
            isPaused: false,
            capturedConfig: first,
            currentConfig: first))
        #expect(!MacNodeModeCoordinator.endpointAttemptCanConnect(
            capturedGeneration: 4,
            currentGeneration: 4,
            isCancelled: false,
            isPaused: true,
            capturedConfig: first,
            currentConfig: first))
        #expect(!MacNodeModeCoordinator.endpointAttemptCanConnect(
            capturedGeneration: 4,
            currentGeneration: 4,
            isCancelled: false,
            isPaused: false,
            capturedConfig: first,
            currentConfig: replacement))
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
        let lifecycle = CoordinatorInvokeLifecycleProbe()
        let routeInvalidationHook = CoordinatorRouteInvalidationHookProbe()
        let drainSnapshot = CoordinatorDrainSnapshotProbe()
        let runtime = MacNodeRuntime(computerControlEnabled: { true })
        let coordinator = MacNodeModeCoordinator(
            session: gateway,
            runtime: runtime,
            initialPaused: false,
            initialComputerControlEnabled: true,
            routeInvalidationHook: { await routeInvalidationHook.run() })
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
        let successor = Task {
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
        try await waitUntil("successor captured first invalidation") {
            await drainSnapshot.hasCaptured()
        }
        coordinator.enqueueRouteInvalidationForTesting()
        let generationsAfterSecondRevocation = coordinator.generationsForTesting()
        #expect(generationsAfterSecondRevocation.routeAuthority == generationsBeforeRefresh.routeAuthority + 2)
        #expect(generationsAfterSecondRevocation.completedRouteAuthority == generationsBeforeRefresh.routeAuthority)

        await lifecycle.releaseInvalidation()
        try await self.waitUntil("second route invalidation hook") {
            await routeInvalidationHook.calls() == 2
        }
        let stateWhileSecondRevocationBlocked = await lifecycle.state()
        #expect(webSocketSession.snapshotMakeCount() == 1)
        #expect(!stateWhileSecondRevocationBlocked.successorConnected)
        let generationsWhileSecondRevocationBlocked = coordinator.generationsForTesting()
        #expect(generationsWhileSecondRevocationBlocked.completedRouteAuthority ==
            generationsBeforeRefresh.routeAuthority + 1)
        #expect(!coordinator.routeAuthorityAllowsInvokeForTesting(
            generationsAfterSecondRevocation.routeAuthority,
            isPaused: false))

        await routeInvalidationHook.releaseBlockedCall()
        try await successor.value

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
        await gateway.disconnect()
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
        #expect(commands.contains(OpenClawCanvasCommand.present.rawValue))
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

    @Test func `tls pin store key uses default wss port`() throws {
        let url = try #require(URL(string: "wss://gateway.example.ts.net"))
        #expect(MacNodeModeCoordinator.tlsPinStoreKey(for: url) == "gateway.example.ts.net:443")
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

        let params = try #require(MacNodeModeCoordinator.tlsParams(
            for: url,
            connectionMode: .remote,
            root: root,
            storedFingerprint: "stored"))

        #expect(params.expectedFingerprint == "sha256:configured")
        #expect(params.allowTOFU == false)
        #expect(params.storeKey == "gateway.example.com:443")
    }

    @Test func `remote tls params allow first use only when no configured or stored pin exists`() throws {
        let url = try #require(URL(string: "wss://gateway.example.com"))

        let params = try #require(MacNodeModeCoordinator.tlsParams(
            for: url,
            connectionMode: .remote,
            root: [:],
            storedFingerprint: nil))

        #expect(params.expectedFingerprint == nil)
        #expect(params.allowTOFU == true)
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

        let params = try #require(MacNodeModeCoordinator.tlsParams(
            for: url,
            connectionMode: .local,
            root: root,
            storedFingerprint: "stored-local"))

        #expect(params.expectedFingerprint == "stored-local")
        #expect(params.allowTOFU == false)
    }

    @Test func `tls session cache reuses session box for unchanged params`() throws {
        let url = try #require(URL(string: "wss://gateway.example.com"))
        var cache = MacNodeGatewayTLSSessionCache()
        let params = try #require(MacNodeModeCoordinator.tlsParams(
            for: url,
            connectionMode: .remote,
            root: ["gateway": ["remote": ["tlsFingerprint": "sha256:configured"]]],
            storedFingerprint: "stored"))

        let first = cache.sessionBox(url: url, params: params)
        let second = cache.sessionBox(url: url, params: params)

        #expect(ObjectIdentifier(first.session) == ObjectIdentifier(second.session))
    }

    @Test func `tls session cache rebuilds session box when params change`() throws {
        let url = try #require(URL(string: "wss://gateway.example.com"))
        var cache = MacNodeGatewayTLSSessionCache()
        let firstParams = try #require(MacNodeModeCoordinator.tlsParams(
            for: url,
            connectionMode: .remote,
            root: ["gateway": ["remote": ["tlsFingerprint": "sha256:configured"]]],
            storedFingerprint: "stored"))
        let secondParams = try #require(MacNodeModeCoordinator.tlsParams(
            for: url,
            connectionMode: .remote,
            root: ["gateway": ["remote": ["tlsFingerprint": "sha256:rotated"]]],
            storedFingerprint: "stored"))

        let first = cache.sessionBox(url: url, params: firstParams)
        let second = cache.sessionBox(url: url, params: secondParams)

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
            systemTrustOk: true)

        #expect(MacNodeModeCoordinator.shouldAutoRepairStaleTLSPin(url: url, failure: failure))
    }

    @Test func `does not auto repair untrusted remote pin mismatch`() throws {
        let url = try #require(URL(string: "wss://gateway.example.com"))
        let failure = GatewayTLSValidationFailure(
            kind: .pinMismatch,
            host: "gateway.example.com",
            storeKey: "gateway.example.com:443",
            expectedFingerprint: "old",
            observedFingerprint: "new",
            systemTrustOk: true)

        #expect(!MacNodeModeCoordinator.shouldAutoRepairStaleTLSPin(url: url, failure: failure))
    }

    @Test func `auto repairs trusted loopback pin mismatch`() throws {
        let url = try #require(URL(string: "wss://127.0.0.1:18789"))
        let failure = GatewayTLSValidationFailure(
            kind: .pinMismatch,
            host: "127.0.0.1",
            storeKey: "127.0.0.1:18789",
            expectedFingerprint: "old",
            observedFingerprint: "new",
            systemTrustOk: true)

        #expect(MacNodeModeCoordinator.shouldAutoRepairStaleTLSPin(url: url, failure: failure))
    }

    @Test func `does not auto repair untrusted loopback pin mismatch`() throws {
        let url = try #require(URL(string: "wss://127.0.0.1:18789"))
        let failure = GatewayTLSValidationFailure(
            kind: .pinMismatch,
            host: "127.0.0.1",
            storeKey: "127.0.0.1:18789",
            expectedFingerprint: "old",
            observedFingerprint: "new",
            systemTrustOk: false)

        #expect(!MacNodeModeCoordinator.shouldAutoRepairStaleTLSPin(url: url, failure: failure))
    }
}
