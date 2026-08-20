import ConcurrencyExtras
import Foundation
import Testing
@testable import OpenClaw
@testable import OpenClawKit

private actor GatewayEndpointSourceGate {
    private var current: GatewayEndpointStore.SourceSnapshot
    private var readCount = 0
    private var suspendNext = false
    private var returnCapturedSource = false
    private var suspendedReadStarted = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiter: CheckedContinuation<Void, Never>?

    init(_ source: GatewayEndpointStore.SourceSnapshot) {
        self.current = source
    }

    func snapshot() async -> GatewayEndpointStore.SourceSnapshot {
        self.readCount += 1
        guard self.suspendNext else { return self.current }
        self.suspendNext = false
        let capturedSource = self.returnCapturedSource ? self.current : nil
        self.returnCapturedSource = false
        self.suspendedReadStarted = true
        for waiter in self.startWaiters {
            waiter.resume()
        }
        self.startWaiters.removeAll()
        await withCheckedContinuation { continuation in
            self.releaseWaiter = continuation
        }
        return capturedSource ?? self.current
    }

    func reads() -> Int {
        self.readCount
    }

    func suspendNextRead(returningCapturedSource: Bool = false) {
        self.suspendNext = true
        self.returnCapturedSource = returningCapturedSource
        self.suspendedReadStarted = false
    }

    func update(_ source: GatewayEndpointStore.SourceSnapshot) {
        self.current = source
    }

    func waitUntilSuspendedReadStarts() async {
        guard !self.suspendedReadStarted else { return }
        await withCheckedContinuation { continuation in
            self.startWaiters.append(continuation)
        }
    }

    func releaseSuspendedRead() {
        self.releaseWaiter?.resume()
        self.releaseWaiter = nil
    }
}

private actor GatewayEndpointRouteLookupGate {
    private var started = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiter: CheckedContinuation<Void, Never>?

    func lookup() async -> RemoteTunnelManager.Route? {
        self.started = true
        for waiter in self.startWaiters {
            waiter.resume()
        }
        self.startWaiters.removeAll()
        await withCheckedContinuation { continuation in
            self.releaseWaiter = continuation
        }
        return nil
    }

    func waitUntilStarted() async {
        guard !self.started else { return }
        await withCheckedContinuation { continuation in
            self.startWaiters.append(continuation)
        }
    }

    func release() {
        self.releaseWaiter?.resume()
        self.releaseWaiter = nil
    }
}

private actor GatewayEndpointRemoteEnsureGate {
    private let route: RemoteTunnelManager.Route
    private var installed = false
    private var lookupCount = 0
    private var ensureStarted = false
    private var lookupWaiters: [(count: Int, continuation: CheckedContinuation<Void, Never>)] = []
    private var ensureStartWaiters: [CheckedContinuation<Void, Never>] = []
    private var ensureReleaseWaiter: CheckedContinuation<Void, Never>?

    init(route: RemoteTunnelManager.Route) {
        self.route = route
    }

    func routeIfRunning() -> RemoteTunnelManager.Route? {
        self.lookupCount += 1
        let ready = self.lookupWaiters.filter { self.lookupCount >= $0.count }
        self.lookupWaiters.removeAll { self.lookupCount >= $0.count }
        for waiter in ready {
            waiter.continuation.resume()
        }
        return self.installed ? self.route : nil
    }

    func isCurrent(_ route: RemoteTunnelManager.Route) -> Bool {
        self.installed && route == self.route
    }

    func ensure() async -> RemoteTunnelManager.Route {
        self.ensureStarted = true
        for waiter in self.ensureStartWaiters {
            waiter.resume()
        }
        self.ensureStartWaiters.removeAll()
        await withCheckedContinuation { continuation in
            self.ensureReleaseWaiter = continuation
        }
        self.installed = true
        return self.route
    }

    func waitUntilLookupCount(_ count: Int) async {
        guard self.lookupCount < count else { return }
        await withCheckedContinuation { continuation in
            self.lookupWaiters.append((count, continuation))
        }
    }

    func waitUntilEnsureStarts() async {
        guard !self.ensureStarted else { return }
        await withCheckedContinuation { continuation in
            self.ensureStartWaiters.append(continuation)
        }
    }

    func releaseEnsure() {
        self.ensureReleaseWaiter?.resume()
        self.ensureReleaseWaiter = nil
    }
}

struct GatewayEndpointStoreTests {
    @MainActor
    @Test func `live local source uses canonical default and named profile ports`() async throws {
        let configPath = TestIsolation.tempConfigPath()
        try Data(#"{"gateway":{"mode":"local"}}"#.utf8)
            .write(to: URL(fileURLWithPath: configPath))
        defer { try? FileManager.default.removeItem(atPath: configPath) }

        try await TestIsolation.withIsolatedState(
            env: [
                "OPENCLAW_CONFIG_PATH": configPath,
                "OPENCLAW_GATEWAY_PORT": nil,
            ],
            defaults: ["gatewayPort": nil])
        {
            let state = AppState(preview: true)
            let base = await GatewayEndpointStore._testLiveSourceSnapshot(
                state: state,
                profile: AppProfile(environment: [:]),
                beforeConfigRead: {})
            let workProfile = AppProfile(environment: ["OPENCLAW_PROFILE": "work"])
            let work = await GatewayEndpointStore._testLiveSourceSnapshot(
                state: state,
                profile: workProfile,
                beforeConfigRead: {})
            #expect(base.localPort == 18789)
            #expect(work.localPort == workProfile.defaultGatewayPort)
        }
    }

    private func makeLaunchAgentSnapshot(
        env: [String: String] = [:],
        token: String? = nil,
        password: String? = nil) -> LaunchAgentPlistSnapshot
    {
        LaunchAgentPlistSnapshot(
            programArguments: [],
            environment: env,
            stdoutPath: nil,
            stderrPath: nil,
            port: nil,
            bind: nil,
            token: token,
            password: password)
    }

    private func makeDefaults() -> UserDefaults {
        let suiteName = "GatewayEndpointStoreTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defaults.removePersistentDomain(forName: suiteName)
        return defaults
    }

    private func makeLaunchAgentTokenSnapshot(_ token: String) -> LaunchAgentPlistSnapshot {
        self.makeLaunchAgentSnapshot(env: ["OPENCLAW_GATEWAY_TOKEN": token], token: token)
    }

    private func makeLaunchAgentPasswordSnapshot(_ password: String) -> LaunchAgentPlistSnapshot {
        self.makeLaunchAgentSnapshot(env: ["OPENCLAW_GATEWAY_PASSWORD": password], password: password)
    }

    private func source(
        mode: AppState.ConnectionMode,
        token: String? = nil,
        password: String? = nil,
        localHost: String = "127.0.0.1",
        bindMode: String? = "loopback",
        transport: AppState.RemoteTransport = .ssh,
        directURL: URL? = nil,
        tlsFingerprint: String? = nil,
        deviceAuthGatewayID: String = "test-gateway-route",
        routingGeneration: UInt64? = nil) -> GatewayEndpointStore.SourceSnapshot
    {
        GatewayEndpointStore.SourceSnapshot(
            routingGeneration: routingGeneration,
            mode: .init(mode),
            token: token,
            password: password,
            deviceAuthGatewayID: deviceAuthGatewayID,
            localPort: 18789,
            localHost: localHost,
            scheme: "ws",
            bindMode: bindMode,
            remoteTransport: .init(transport),
            directRemoteURL: directURL,
            remoteTLSFingerprint: tlsFingerprint,
            sshRouteIdentity: mode == .remote && transport == .ssh
                ? .init(
                    target: "user@gateway.example",
                    identity: "",
                    hostKeyPolicy: "strict",
                    configuredRemotePort: nil,
                    configuredRemoteURL: nil)
                : nil)
    }

    private func localAuthRoot(_ key: String, value: String) -> [String: Any] {
        ["gateway": ["auth": [key: value]]]
    }

    private func makeStore(
        sourceSnapshot: @escaping @Sendable () async -> GatewayEndpointStore.SourceSnapshot,
        token: @escaping @Sendable () -> String? = { nil },
        remoteRouteIfRunning: @escaping @Sendable () async -> RemoteTunnelManager.Route? = { nil },
        remoteRouteIsCurrent: @escaping @Sendable (RemoteTunnelManager.Route) async -> Bool = { _ in true },
        canStartRemoteTunnel: @escaping @Sendable () -> Bool = { true },
        ensureRemoteTunnel: @escaping @Sendable () async throws -> RemoteTunnelManager.Route = {
            throw CancellationError()
        },
        liveSourceIsCurrent: @escaping @Sendable (GatewayEndpointStore.SourceSnapshot) async -> Bool = { _ in true })
        -> GatewayEndpointStore
    {
        GatewayEndpointStore(deps: .init(
            token: token,
            password: { nil },
            localPort: { 18789 },
            localUnavailableReason: { nil },
            remoteRouteIfRunning: remoteRouteIfRunning,
            remoteRouteIsCurrent: remoteRouteIsCurrent,
            canStartRemoteTunnel: canStartRemoteTunnel,
            ensureRemoteTunnel: ensureRemoteTunnel,
            liveSourceIsCurrent: liveSourceIsCurrent,
            sourceSnapshot: sourceSnapshot))
    }

    private func resolveMode(
        configMode: String? = nil,
        storedMode: String,
        remoteURL: String? = nil) -> EffectiveConnectionMode
    {
        let defaults = self.makeDefaults()
        defaults.set(storedMode, forKey: connectionModeKey)
        var gateway: [String: Any] = [:]
        if let configMode {
            gateway["mode"] = configMode
        }
        if let remoteURL {
            gateway["remote"] = ["url": remoteURL]
        }
        let root: [String: Any] = gateway.isEmpty ? [:] : ["gateway": gateway]
        return ConnectionModeResolver.resolve(root: root, defaults: defaults)
    }

    @Test func `local conflict remains unavailable across refresh until cleared`() async throws {
        let source = self.source(mode: .local)
        let store = self.makeStore(sourceSnapshot: { source })

        await store.setLocalUnavailableReason("Profile port conflict")
        await store.refresh()
        #expect(await store.currentState() == .unavailable(
            mode: .local,
            reason: "Profile port conflict"))
        await #expect(throws: Error.self) {
            _ = try await store.requireEndpoint()
        }

        await store.setLocalUnavailableReason(nil)
        await store.refresh()
        guard case .ready = await store.currentState() else {
            Issue.record("Expected local endpoint to recover after conflict clears")
            return
        }
    }

    private func dashboardURL(
        _ endpoint: String,
        mode: AppState.ConnectionMode,
        localBasePath: String,
        token: String? = nil,
        password: String? = nil,
        authToken: String? = nil) throws -> URL
    {
        let config: GatewayConnection.Config = try (
            url: #require(URL(string: endpoint)),
            token: token,
            password: password)
        return try GatewayEndpointStore.dashboardURL(
            for: config,
            mode: mode,
            localBasePath: localBasePath,
            authToken: authToken)
    }

    @Test func `resolve gateway token prefers env and falls back to launchd`() {
        let snapshot = self.makeLaunchAgentTokenSnapshot("launchd-token")

        let envToken = GatewayEndpointStore._testResolveGatewayToken(
            isRemote: false,
            root: [:],
            env: ["OPENCLAW_GATEWAY_TOKEN": "env-token"],
            launchdSnapshot: snapshot)
        #expect(envToken == "env-token")

        let fallbackToken = GatewayEndpointStore._testResolveGatewayToken(
            isRemote: false,
            root: [:],
            env: [:],
            launchdSnapshot: snapshot)
        #expect(fallbackToken == "launchd-token")
    }

    @Test func `resolve gateway token skips unresolved env template before launchd fallback`() throws {
        let snapshot = self.makeLaunchAgentTokenSnapshot("launchd-token")
        let root = self.localAuthRoot("token", value: "${OPENCLAW_GATEWAY_TOKEN}")

        let token = GatewayEndpointStore._testResolveGatewayToken(
            isRemote: false,
            root: root,
            env: [:],
            launchdSnapshot: snapshot)
        #expect(token == "launchd-token")

        let url = try self.dashboardURL(
            "ws://127.0.0.1:18789",
            mode: .local,
            localBasePath: "/control",
            token: token)
        #expect(url.absoluteString == "http://127.0.0.1:18789/control/#token=launchd-token")
    }

    @Test func `resolve gateway token skips unresolved env shorthand before launchd fallback`() {
        let snapshot = self.makeLaunchAgentTokenSnapshot("launchd-token")
        let root = self.localAuthRoot("token", value: "$OPENCLAW_GATEWAY_TOKEN")

        let token = GatewayEndpointStore._testResolveGatewayToken(
            isRemote: false,
            root: root,
            env: [:],
            launchdSnapshot: snapshot)
        #expect(token == "launchd-token")
    }

    @Test func `resolve gateway token resolves env template from app environment`() {
        let snapshot = self.makeLaunchAgentSnapshot(
            env: [
                "CUSTOM_GATEWAY_TOKEN": "service-token",
                "OPENCLAW_GATEWAY_TOKEN": "launchd-token",
            ],
            token: "launchd-token")
        let root = self.localAuthRoot("token", value: "${CUSTOM_GATEWAY_TOKEN}")

        let token = GatewayEndpointStore._testResolveGatewayToken(
            isRemote: false,
            root: root,
            env: ["CUSTOM_GATEWAY_TOKEN": "  custom-token  "],
            launchdSnapshot: snapshot)
        #expect(token == "custom-token")
    }

    @Test func `resolve gateway token resolves env template from gateway service environment`() {
        let snapshot = self.makeLaunchAgentSnapshot(
            env: ["CUSTOM_GATEWAY_TOKEN": "  service-token  "])
        let root = self.localAuthRoot("token", value: "${CUSTOM_GATEWAY_TOKEN}")

        let token = GatewayEndpointStore._testResolveGatewayToken(
            isRemote: false,
            root: root,
            env: ["CUSTOM_GATEWAY_TOKEN": "  "],
            launchdSnapshot: snapshot)
        #expect(token == "service-token")
    }

    @Test func `resolve gateway token keeps invalid env template as plaintext`() {
        let snapshot = self.makeLaunchAgentTokenSnapshot("launchd-token")
        let root = self.localAuthRoot("token", value: "${custom_gateway_token}")

        let token = GatewayEndpointStore._testResolveGatewayToken(
            isRemote: false,
            root: root,
            env: ["custom_gateway_token": "custom-token"],
            launchdSnapshot: snapshot)
        #expect(token == "${custom_gateway_token}")
    }

    @Test func `resolve gateway token omits unresolved env template without fallback`() throws {
        let root = self.localAuthRoot("token", value: "${OPENCLAW_GATEWAY_TOKEN}")

        let token = GatewayEndpointStore._testResolveGatewayToken(
            isRemote: false,
            root: root,
            env: [:],
            launchdSnapshot: nil)
        #expect(token == nil)

        let url = try self.dashboardURL(
            "ws://127.0.0.1:18789",
            mode: .local,
            localBasePath: "/control",
            token: token)
        #expect(url.absoluteString == "http://127.0.0.1:18789/control/")
    }

    @Test func `resolve gateway token ignores launchd in remote mode`() {
        let snapshot = self.makeLaunchAgentTokenSnapshot("launchd-token")

        let token = GatewayEndpointStore._testResolveGatewayToken(
            isRemote: true,
            root: [:],
            env: [:],
            launchdSnapshot: snapshot)
        #expect(token == nil)
    }

    @Test func `resolve gateway token uses remote config token`() {
        let token = GatewayEndpointStore._testResolveGatewayToken(
            isRemote: true,
            root: [
                "gateway": [
                    "remote": [
                        "token": "  remote-token  ",
                    ],
                ],
            ],
            env: [:],
            launchdSnapshot: nil)
        #expect(token == "remote-token")
    }

    @Test func `remote password resolver trims remote config password`() {
        let root: [String: Any] = [
            "gateway": [
                "remote": [
                    "password": "  remote-pass  ",
                ],
            ],
        ]

        #expect(GatewayRemoteConfig.resolvePasswordString(root: root) == "remote-pass")
    }

    @Test func `resolve gateway password falls back to launchd`() {
        let snapshot = self.makeLaunchAgentPasswordSnapshot("launchd-pass")

        let password = GatewayEndpointStore._testResolveGatewayPassword(
            isRemote: false,
            root: [:],
            env: [:],
            launchdSnapshot: snapshot)
        #expect(password == "launchd-pass")
    }

    @Test func `resolve gateway password skips unresolved env template before launchd fallback`() {
        let snapshot = self.makeLaunchAgentPasswordSnapshot("launchd-pass")
        let root = self.localAuthRoot("password", value: "${OPENCLAW_GATEWAY_PASSWORD}")

        let password = GatewayEndpointStore._testResolveGatewayPassword(
            isRemote: false,
            root: root,
            env: [:],
            launchdSnapshot: snapshot)
        #expect(password == "launchd-pass")
    }

    @Test func `resolve gateway password skips unresolved env shorthand before launchd fallback`() {
        let snapshot = self.makeLaunchAgentPasswordSnapshot("launchd-pass")
        let root = self.localAuthRoot("password", value: "$OPENCLAW_GATEWAY_PASSWORD")

        let password = GatewayEndpointStore._testResolveGatewayPassword(
            isRemote: false,
            root: root,
            env: [:],
            launchdSnapshot: snapshot)
        #expect(password == "launchd-pass")
    }

    @Test func `resolve gateway password resolves env template from gateway service environment`() {
        let snapshot = self.makeLaunchAgentSnapshot(
            env: ["CUSTOM_GATEWAY_PASSWORD": "  service-pass  "])
        let root = self.localAuthRoot("password", value: "${CUSTOM_GATEWAY_PASSWORD}")

        let password = GatewayEndpointStore._testResolveGatewayPassword(
            isRemote: false,
            root: root,
            env: [:],
            launchdSnapshot: snapshot)
        #expect(password == "service-pass")
    }

    @Test func `connection mode resolver prefers config mode over defaults`() {
        let resolved = self.resolveMode(configMode: " local ", storedMode: "remote")
        #expect(resolved.mode == .local)
    }

    @Test func `connection mode resolver trims config mode`() {
        let resolved = self.resolveMode(configMode: " remote ", storedMode: "local")
        #expect(resolved.mode == .remote)
    }

    @Test func `connection mode resolver falls back to defaults when missing config`() {
        let resolved = self.resolveMode(storedMode: "remote")
        #expect(resolved.mode == .remote)
    }

    @Test func `connection mode resolver falls back to defaults on unknown config`() {
        let resolved = self.resolveMode(configMode: "staging", storedMode: "local")
        #expect(resolved.mode == .local)
    }

    @Test func `connection mode resolver prefers remote URL when mode missing`() {
        let resolved = self.resolveMode(storedMode: "local", remoteURL: " ws://umbrel:18789 ")
        #expect(resolved.mode == .remote)
    }
}

extension GatewayEndpointStoreTests {
    @Test func `remote tunnel waits for primary app launch admission`() async {
        await TestIsolation.withUserDefaultsValues([connectionModeKey: "unconfigured"]) {
            let admitted = LockIsolated(false)
            let tunnelStarts = LockIsolated(0)
            let source = self.source(mode: .remote, transport: .ssh)
            let store = self.makeStore(
                sourceSnapshot: { source },
                canStartRemoteTunnel: { admitted.withValue { $0 } },
                ensureRemoteTunnel: {
                    tunnelStarts.withValue { $0 += 1 }
                    return .init(localPort: 18789, generation: 1)
                })

            await store.refresh()
            #expect(tunnelStarts.withValue { $0 } == 0)

            admitted.withValue { $0 = true }
            let port = try? await store.ensureRemoteControlTunnel()
            #expect(port == 18789)
            #expect(tunnelStarts.withValue { $0 } == 1)
        }
    }

    @Test func `concurrent endpoint reads for the same selection both succeed`() async throws {
        try await TestIsolation.withUserDefaultsValues([connectionModeKey: "unconfigured"]) {
            let source = self.source(mode: .local, token: "same-token")
            let sourceGate = GatewayEndpointSourceGate(source)
            await sourceGate.suspendNextRead()
            let store = self.makeStore(sourceSnapshot: { await sourceGate.snapshot() })

            let first = Task { try await store.requireEndpoint() }
            await sourceGate.waitUntilSuspendedReadStarts()
            let second = Task { try await store.requireEndpoint() }
            let secondEndpoint = try await second.value
            await sourceGate.releaseSuspendedRead()
            let firstEndpoint = try await first.value

            #expect(firstEndpoint.config.url == secondEndpoint.config.url)
            #expect(firstEndpoint.config.token == "same-token")
            #expect(firstEndpoint.revision == secondEndpoint.revision)
        }
    }

    @Test func `routing generation avoids redundant source reads within each request`() async throws {
        try await TestIsolation.withUserDefaultsValues([connectionModeKey: "unconfigured"]) {
            let source = self.source(mode: .local, token: "same-token", routingGeneration: 7)
            let sourceGate = GatewayEndpointSourceGate(source)
            let store = self.makeStore(
                sourceSnapshot: { await sourceGate.snapshot() },
                liveSourceIsCurrent: { $0.routingGeneration == 7 })

            _ = try await store.requireEndpoint()
            #expect(await sourceGate.reads() == 1)

            _ = try await store.requireEndpoint()
            #expect(await sourceGate.reads() == 2)
        }
    }

    @Test func `live source validation rejects tailnet address changes`() {
        let source = self.source(
            mode: .local,
            localHost: "100.64.1.5",
            bindMode: "tailnet",
            routingGeneration: 7)

        #expect(GatewayEndpointStore._testLiveSourceIsCurrent(
            source,
            currentRoutingGeneration: 7,
            currentTailnetIP: "100.64.1.5"))
        #expect(!GatewayEndpointStore._testLiveSourceIsCurrent(
            source,
            currentRoutingGeneration: 7,
            currentTailnetIP: "100.64.1.6"))
        #expect(!GatewayEndpointStore._testLiveSourceIsCurrent(
            source,
            currentRoutingGeneration: 8,
            currentTailnetIP: "100.64.1.5"))
    }

    @Test func `remote TLS fingerprint changes advance endpoint revision`() async throws {
        try await TestIsolation.withUserDefaultsValues([connectionModeKey: "unconfigured"]) {
            let url = try #require(URL(string: "wss://gateway.example.invalid"))
            let sourceA = self.source(
                mode: .remote,
                transport: .direct,
                directURL: url,
                tlsFingerprint: String(repeating: "a", count: 64))
            let sourceGate = GatewayEndpointSourceGate(sourceA)
            let store = self.makeStore(sourceSnapshot: { await sourceGate.snapshot() })

            let first = try await store.requireEndpoint()
            await sourceGate.update(self.source(
                mode: .remote,
                transport: .direct,
                directURL: url,
                tlsFingerprint: String(repeating: "b", count: 64)))
            let second = try await store.requireEndpoint()

            let firstRevision = try #require(first.revision)
            let secondRevision = try #require(second.revision)
            #expect(first.tls?.params.expectedFingerprint == String(repeating: "a", count: 64))
            #expect(second.tls?.params.expectedFingerprint == String(repeating: "b", count: 64))
            #expect(secondRevision > firstRevision)
        }
    }

    @Test func `persisting active first use pin keeps endpoint revision stable`() async throws {
        try await withFakeGatewayTLSKeychain {
            try await TestIsolation.withUserDefaultsValues([connectionModeKey: "unconfigured"]) {
                let url = try #require(URL(string: "wss://gateway.example.invalid"))
                let storeKey = GatewayTLSRoute.storeKey(for: url)
                let source = self.source(
                    mode: .remote,
                    transport: .direct,
                    directURL: url)
                let store = self.makeStore(sourceSnapshot: { source })

                let first = try await store.requireEndpoint()
                let fingerprint = String(repeating: "a", count: 64)
                _ = GatewayTLSStore.claimFirstUseFingerprint(fingerprint, stableID: storeKey)
                let second = try await store.requireEndpoint()

                #expect(first.revision == second.revision)
                #expect(second.tls?.params.allowTOFU == false)
                #expect(second.tls?.params.expectedFingerprint == fingerprint)
                #expect(GatewayTLSRoute.hasSameConnectionIdentity(first.tls, second.tls))
            }
        }
    }

    @Test func `require endpoint rejects a source superseded by a different selection`() async throws {
        try await TestIsolation.withUserDefaultsValues([connectionModeKey: "unconfigured"]) {
            let sourceA = self.source(mode: .remote, token: "token-a", transport: .ssh)
            let remoteURL = try #require(URL(string: "ws://192.168.1.20:18789"))
            let sourceB = self.source(
                mode: .remote,
                token: "token-b",
                password: "password-b",
                transport: .direct,
                directURL: remoteURL)
            let sourceGate = GatewayEndpointSourceGate(sourceA)
            let routeGate = GatewayEndpointRouteLookupGate()
            let store = self.makeStore(
                sourceSnapshot: { await sourceGate.snapshot() },
                remoteRouteIfRunning: { await routeGate.lookup() })

            let staleRequest = Task { try await store.requireEndpoint() }
            await routeGate.waitUntilStarted()
            await sourceGate.update(sourceB)
            let currentEndpoint = try await store.requireEndpoint()
            await routeGate.release()

            await #expect(throws: CancellationError.self) {
                try await staleRequest.value
            }
            #expect(currentEndpoint.config.url == remoteURL)
            #expect(currentEndpoint.config.token == "token-b")
            #expect(currentEndpoint.config.password == "password-b")
        }
    }

    @Test func `require endpoint rejects a generation superseded after source read`() async throws {
        try await TestIsolation.withUserDefaultsValues([connectionModeKey: "unconfigured"]) {
            let remoteURL = try #require(URL(string: "ws://192.168.1.20:18789"))
            let sourceA = self.source(
                mode: .remote,
                token: "same-token",
                transport: .direct,
                directURL: remoteURL,
                routingGeneration: 1)
            let sourceB = self.source(
                mode: .remote,
                token: "same-token",
                transport: .direct,
                directURL: remoteURL,
                routingGeneration: 2)
            let currentRoutingGeneration = LockIsolated<UInt64>(1)
            let sourceGate = GatewayEndpointSourceGate(sourceA)
            await sourceGate.suspendNextRead(returningCapturedSource: true)
            let store = self.makeStore(
                sourceSnapshot: { await sourceGate.snapshot() },
                liveSourceIsCurrent: { source in
                    currentRoutingGeneration.withValue { $0 == source.routingGeneration }
                })

            let staleRequest = Task { try await store.requireEndpoint() }
            await sourceGate.waitUntilSuspendedReadStarts()
            currentRoutingGeneration.withValue { $0 = 2 }
            await sourceGate.releaseSuspendedRead()

            await #expect(throws: CancellationError.self) {
                try await staleRequest.value
            }
            await sourceGate.update(sourceB)
            let currentEndpoint = try await store.requireEndpoint()
            #expect(currentEndpoint.config.url == remoteURL)
            #expect(currentEndpoint.config.token == "same-token")
        }
    }

    @Test func `require endpoint rejects cancellation during endpoint resolution`() async {
        await TestIsolation.withUserDefaultsValues([connectionModeKey: "unconfigured"]) {
            let sourceGate = GatewayEndpointSourceGate(self.source(mode: .local))
            await sourceGate.suspendNextRead()
            let store = self.makeStore(sourceSnapshot: { await sourceGate.snapshot() })

            let request = Task { try await store.requireEndpoint() }
            await sourceGate.waitUntilSuspendedReadStarts()
            request.cancel()
            await sourceGate.releaseSuspendedRead()

            await #expect(throws: CancellationError.self) {
                try await request.value
            }
        }
    }

    @Test func `tailnet fallback cannot overwrite a replacement remote selection`() async throws {
        try await TestIsolation.withUserDefaultsValues([connectionModeKey: "local"]) {
            let fallbackSource = self.source(
                mode: .local,
                token: "local-token",
                localHost: "100.64.1.8",
                bindMode: "tailnet")
            let remoteURL = try #require(URL(string: "ws://192.168.1.20:18789"))
            let remoteSource = self.source(
                mode: .remote,
                token: "remote-token",
                transport: .direct,
                directURL: remoteURL)
            let sourceGate = GatewayEndpointSourceGate(fallbackSource)
            let store = self.makeStore(
                sourceSnapshot: { await sourceGate.snapshot() },
                token: { "local-token" })
            let initialURL = try #require(URL(string: "ws://127.0.0.1:18789"))

            await sourceGate.suspendNextRead()
            let fallback = Task { await store.maybeFallbackToTailnet(from: initialURL) }
            await sourceGate.waitUntilSuspendedReadStarts()
            await sourceGate.update(remoteSource)
            let remoteEndpoint = try await store.requireEndpoint()
            await sourceGate.releaseSuspendedRead()

            #expect(await fallback.value == nil)
            #expect(remoteEndpoint.config.url == remoteURL)
            #expect(remoteEndpoint.config.token == "remote-token")
            let currentEndpoint = try await store.requireEndpoint()
            #expect(currentEndpoint.config.url == remoteURL)
        }
    }

    @Test func `same URL owner replacement publishes a new route revision`() async throws {
        try await TestIsolation.withUserDefaultsValues([connectionModeKey: "unconfigured"]) {
            let url = try #require(URL(string: "wss://gateway.example.test"))
            let sourceA = self.source(
                mode: .remote,
                transport: .direct,
                directURL: url,
                deviceAuthGatewayID: "route-a")
            let sourceB = self.source(
                mode: .remote,
                transport: .direct,
                directURL: url,
                deviceAuthGatewayID: "route-b")
            let sourceGate = GatewayEndpointSourceGate(sourceA)
            let store = self.makeStore(sourceSnapshot: { await sourceGate.snapshot() })
            let stream = await store.subscribe(bufferingNewest: 10)
            var iterator = stream.makeAsyncIterator()
            _ = await iterator.next()

            let endpointA = try await store.requireEndpoint()
            let stateA = await iterator.next()
            await sourceGate.update(sourceB)
            let endpointB = try await store.requireEndpoint()
            let stateB = await iterator.next()

            #expect(endpointA.config.url == endpointB.config.url)
            #expect(endpointA.revision != endpointB.revision)
            guard let stateA,
                  let stateB,
                  case let .ready(_, _, _, _, revisionA) = stateA,
                  case let .ready(_, _, _, _, revisionB) = stateB
            else {
                Issue.record("expected ready route revisions")
                return
            }
            #expect(revisionA == endpointA.revision)
            #expect(revisionB == endpointB.revision)
            #expect(revisionA != revisionB)
        }
    }

    @Test func `cancelling one remote waiter does not poison a shared tunnel ensure`() async throws {
        try await TestIsolation.withUserDefaultsValues([connectionModeKey: "unconfigured"]) {
            let source = self.source(
                mode: .remote,
                token: "remote-token",
                transport: .ssh)
            let remoteGate = GatewayEndpointRemoteEnsureGate(
                route: .init(localPort: 28789, generation: 7))
            let store = self.makeStore(
                sourceSnapshot: { source },
                remoteRouteIfRunning: { await remoteGate.routeIfRunning() },
                remoteRouteIsCurrent: { await remoteGate.isCurrent($0) },
                ensureRemoteTunnel: { await remoteGate.ensure() })

            let cancelledWaiter = Task { try await store.requireEndpoint() }
            await remoteGate.waitUntilEnsureStarts()
            let currentWaiter = Task { try await store.requireEndpoint() }
            await remoteGate.waitUntilLookupCount(2)
            await Task.yield()
            await Task.yield()
            cancelledWaiter.cancel()
            await remoteGate.releaseEnsure()

            await #expect(throws: CancellationError.self) {
                try await cancelledWaiter.value
            }
            let endpoint = try await currentWaiter.value
            #expect(endpoint.config.url.absoluteString == "ws://127.0.0.1:28789")
            #expect(endpoint.config.token == "remote-token")
            #expect(endpoint.routeAuthority == 7)
            let reused = try await store.requireEndpoint()
            #expect(reused.routeAuthority == 7)
        }
    }

    @Test func `concurrent remote waiters join one tunnel ensure and both succeed`() async throws {
        try await TestIsolation.withUserDefaultsValues([connectionModeKey: "unconfigured"]) {
            let source = self.source(
                mode: .remote,
                token: "remote-token",
                transport: .ssh)
            let remoteGate = GatewayEndpointRemoteEnsureGate(
                route: .init(localPort: 28789, generation: 9))
            let store = self.makeStore(
                sourceSnapshot: { source },
                remoteRouteIfRunning: { await remoteGate.routeIfRunning() },
                remoteRouteIsCurrent: { await remoteGate.isCurrent($0) },
                ensureRemoteTunnel: { await remoteGate.ensure() })

            let first = Task { try await store.requireEndpoint() }
            await remoteGate.waitUntilEnsureStarts()
            let second = Task { try await store.requireEndpoint() }
            await remoteGate.waitUntilLookupCount(2)
            await Task.yield()
            await Task.yield()
            await remoteGate.releaseEnsure()

            let firstEndpoint = try await first.value
            let secondEndpoint = try await second.value
            #expect(firstEndpoint.config.url == secondEndpoint.config.url)
            #expect(firstEndpoint.routeAuthority == 9)
            #expect(firstEndpoint.revision == secondEndpoint.revision)
        }
    }

    @Test func `resolve local gateway host uses loopback for auto even with tailnet`() {
        let host = GatewayEndpointStore._testResolveLocalGatewayHost(
            bindMode: "auto",
            tailscaleIP: "100.64.1.2")
        #expect(host == "127.0.0.1")
    }

    @Test func `resolve local gateway host uses loopback for auto without tailnet`() {
        let host = GatewayEndpointStore._testResolveLocalGatewayHost(
            bindMode: "auto",
            tailscaleIP: nil)
        #expect(host == "127.0.0.1")
    }

    @Test func `resolve local gateway host prefers tailnet for tailnet mode`() {
        let host = GatewayEndpointStore._testResolveLocalGatewayHost(
            bindMode: "tailnet",
            tailscaleIP: "100.64.1.5")
        #expect(host == "100.64.1.5")
    }

    @Test func `resolve local gateway host falls back to loopback for tailnet mode`() {
        let host = GatewayEndpointStore._testResolveLocalGatewayHost(
            bindMode: "tailnet",
            tailscaleIP: nil)
        #expect(host == "127.0.0.1")
    }

    @Test func `resolve local gateway host uses custom bind host`() {
        let host = GatewayEndpointStore._testResolveLocalGatewayHost(
            bindMode: "custom",
            tailscaleIP: "100.64.1.9",
            customBindHost: "192.168.1.10")
        #expect(host == "192.168.1.10")
    }

    @Test func `local config uses local gateway auth and host resolution`() {
        let snapshot = self.makeLaunchAgentSnapshot(
            env: [:],
            token: "launchd-token",
            password: "launchd-pass")
        let root: [String: Any] = [
            "gateway": [
                "bind": "tailnet",
                "tls": ["enabled": true],
                "remote": [
                    "url": "wss://remote.example:443",
                    "token": "remote-token",
                ],
            ],
        ]

        let config = GatewayEndpointStore._testLocalConfig(
            root: root,
            env: [:],
            launchdSnapshot: snapshot,
            tailscaleIP: "100.64.1.8")

        #expect(config.url.absoluteString == "wss://100.64.1.8:\(GatewayEnvironment.gatewayPort())")
        #expect(config.token == "launchd-token")
        #expect(config.password == "launchd-pass")
    }

    @Test func `dashboard URL uses local base path in local mode`() throws {
        let url = try self.dashboardURL(
            "ws://127.0.0.1:18789",
            mode: .local,
            localBasePath: " control ")
        #expect(url.absoluteString == "http://127.0.0.1:18789/control/")
    }

    @Test func `dashboard URL skips local base path in remote mode`() throws {
        let url = try self.dashboardURL(
            "ws://gateway.example:18789",
            mode: .remote,
            localBasePath: "/local-ui")
        #expect(url.absoluteString == "http://gateway.example:18789/")
    }

    @Test func `dashboard URL prefers path from config URL`() throws {
        let url = try self.dashboardURL(
            "wss://gateway.example:443/remote-ui",
            mode: .remote,
            localBasePath: "/local-ui")
        #expect(url.absoluteString == "https://gateway.example:443/remote-ui/")
    }

    @Test func `dashboard URL uses fragment token and omits password`() throws {
        let url = try self.dashboardURL(
            "ws://127.0.0.1:18789",
            mode: .local,
            localBasePath: "/control",
            token: "abc123",
            password: "sekret") // pragma: allowlist secret
        #expect(url.absoluteString == "http://127.0.0.1:18789/control/#token=abc123")
        #expect(url.query == nil)
    }

    @Test func `dashboard URL can use native auth token override`() throws {
        let url = try self.dashboardURL(
            "ws://127.0.0.1:18789",
            mode: .local,
            localBasePath: "/control",
            password: "sekret", // pragma: allowlist secret
            authToken: "device-token")
        #expect(url.absoluteString == "http://127.0.0.1:18789/control/#token=device-token")
        #expect(url.query == nil)
    }

    @Test func `normalize gateway url adds default port for loopback ws`() {
        let url = GatewayRemoteConfig.normalizeGatewayUrl("ws://127.0.0.1")
        #expect(url?.port == 18789)
        #expect(url?.absoluteString == "ws://127.0.0.1:18789")
    }

    @Test func `normalize gateway url accepts private network ws`() {
        let url = GatewayRemoteConfig.normalizeGatewayUrl("ws://192.168.0.202:18789")
        #expect(url?.absoluteString == "ws://192.168.0.202:18789")
    }

    @Test func `normalize gateway url accepts tailnet ws`() {
        let url = GatewayRemoteConfig.normalizeGatewayUrl("ws://100.123.224.76:18789")
        #expect(url?.absoluteString == "ws://100.123.224.76:18789")
    }

    @Test func `gateway url validation guidance matches trusted plaintext policy`() {
        let accepted = [
            "ws://localhost:18789",
            "ws://192.168.0.202:18789",
            "ws://169.254.20.1:18789",
            "ws://gateway.local:18789",
            "ws://gateway.example.ts.net:18789",
            "ws://100.123.224.76:18789",
        ]
        for rawURL in accepted {
            #expect(GatewayRemoteConfig.normalizeGatewayUrl(rawURL) != nil)
        }
        #expect(GatewayRemoteConfig.normalizeGatewayUrl("ws://gateway.example:18789") == nil)

        let message = GatewayRemoteConfig.directGatewayUrlValidationMessage
        #expect(message.contains("public hosts"))
        #expect(message.contains("localhost"))
        #expect(message.contains("LAN"))
        #expect(message.contains("link-local"))
        #expect(message.contains(".local"))
        #expect(message.contains("Tailnet"))
        #expect(!message.contains("only for localhost"))
    }

    @Test func `missing transport infers direct from private remote URL`() {
        let root: [String: Any] = [
            "gateway": [
                "remote": [
                    "url": "ws://192.168.0.202:18789",
                ],
            ],
        ]

        let resolution = GatewayRemoteConfig.resolveTransportResolution(root: root)
        #expect(resolution.transport == .direct)
        #expect(resolution.source == .inferredRemoteURL)
        #expect(resolution.directURL?.absoluteString == "ws://192.168.0.202:18789")
    }

    @Test func `legacy loopback URL keeps SSH even with trusted SSH target`() {
        let root: [String: Any] = [
            "gateway": [
                "remote": [
                    "url": "ws://127.0.0.1:18789",
                    "sshTarget": "steipete@192.168.0.202",
                ],
            ],
        ]

        let resolution = GatewayRemoteConfig.resolveTransportResolution(root: root)
        #expect(resolution.transport == .ssh)
        #expect(resolution.source == .legacySSH)
        #expect(resolution.directURL == nil)
    }

    @Test func `explicit ssh keeps legacy tunnel even when target is direct capable`() {
        let root: [String: Any] = [
            "gateway": [
                "remote": [
                    "transport": "ssh",
                    "url": "ws://127.0.0.1:18789",
                    "sshTarget": "steipete@192.168.0.202",
                ],
            ],
        ]

        let resolution = GatewayRemoteConfig.resolveTransportResolution(root: root)
        #expect(resolution.transport == .ssh)
        #expect(resolution.source == .explicit)
        #expect(resolution.directURL == nil)
    }

    @Test func `ssh tunnel reuse requires the complete captured route configuration`() throws {
        let targetA = try #require(CommandResolver.parseSSHTarget("alice@gateway-a.example:22"))
        let equivalentTargetA = try #require(CommandResolver.parseSSHTarget("alice@gateway-a.example"))
        let targetB = try #require(CommandResolver.parseSSHTarget("bob@gateway-b.example:2200"))
        let routeA = RemotePortTunnel.Configuration(
            target: targetA,
            identity: "/tmp/id-a",
            remotePort: 18789,
            hostKeyPolicy: .strict)

        #expect(RemoteTunnelManager._testCanReuse(routeA, for: routeA))
        #expect(RemoteTunnelManager._testCanReuse(
            routeA,
            for: .init(
                target: equivalentTargetA,
                identity: routeA.identity,
                remotePort: routeA.remotePort,
                hostKeyPolicy: routeA.hostKeyPolicy)))
        #expect(!RemoteTunnelManager._testCanReuse(
            routeA,
            for: .init(
                target: targetB,
                identity: routeA.identity,
                remotePort: routeA.remotePort,
                hostKeyPolicy: routeA.hostKeyPolicy)))
        #expect(!RemoteTunnelManager._testCanReuse(
            routeA,
            for: .init(
                target: routeA.target,
                identity: "/tmp/id-b",
                remotePort: routeA.remotePort,
                hostKeyPolicy: routeA.hostKeyPolicy)))
        #expect(!RemoteTunnelManager._testCanReuse(
            routeA,
            for: .init(
                target: routeA.target,
                identity: routeA.identity,
                remotePort: 28789,
                hostKeyPolicy: routeA.hostKeyPolicy)))
        #expect(!RemoteTunnelManager._testCanReuse(
            routeA,
            for: .init(
                target: routeA.target,
                identity: routeA.identity,
                remotePort: routeA.remotePort,
                hostKeyPolicy: .openssh)))
    }

    @Test func `ssh restart backoff propagates cancellation`() async {
        await #expect(throws: CancellationError.self) {
            try await RemoteTunnelManager._testWaitForRestartBackoff(seconds: 2) { _ in
                throw CancellationError()
            }
        }
    }

    @Test func `stale ssh waiter cannot replace current tunnel create`() throws {
        let oldTarget = try #require(CommandResolver.parseSSHTarget("alice@gateway-a.example"))
        let newTarget = try #require(CommandResolver.parseSSHTarget("alice@gateway-b.example"))
        let oldConfiguration = RemotePortTunnel.Configuration(
            target: oldTarget,
            identity: "/tmp/id-a",
            remotePort: 18789,
            hostKeyPolicy: .strict)
        let newConfiguration = RemotePortTunnel.Configuration(
            target: newTarget,
            identity: "/tmp/id-b",
            remotePort: 18789,
            hostKeyPolicy: .strict)

        #expect(!RemoteTunnelManager._testIsCurrentConfiguration(
            requested: oldConfiguration,
            current: newConfiguration))
        #expect(RemoteTunnelManager._testIsCurrentConfiguration(
            requested: newConfiguration,
            current: newConfiguration))
    }

    @Test func `normalize gateway url rejects public host ws`() {
        let url = GatewayRemoteConfig.normalizeGatewayUrl("ws://gateway.example:18789")
        #expect(url == nil)
    }

    @Test func `normalize gateway url rejects private ipv4 suffix host bypasses`() {
        #expect(GatewayRemoteConfig.normalizeGatewayUrl("ws://192.168.0.202.attacker.example:18789") == nil)
        #expect(GatewayRemoteConfig.normalizeGatewayUrl("ws://100.123.224.76.attacker.example:18789") == nil)
    }

    @Test func `normalize gateway url rejects ipv6 prefix hostname bypasses`() {
        #expect(GatewayRemoteConfig.normalizeGatewayUrl("ws://fcorp.example:18789") == nil)
        #expect(GatewayRemoteConfig.normalizeGatewayUrl("ws://fd-example.com:18789") == nil)
    }

    @Test func `normalize gateway url rejects prefix bypass loopback host`() {
        let url = GatewayRemoteConfig.normalizeGatewayUrl("ws://127.attacker.example")
        #expect(url == nil)
    }

    @Test func `resolve tls fingerprint trims remote config value`() {
        let root: [String: Any] = [
            "gateway": [
                "remote": [
                    "tlsFingerprint": " sha256:ABC123 ",
                ],
            ],
        ]

        #expect(GatewayRemoteConfig.resolveTLSFingerprint(root: root) == "sha256:ABC123")
    }

    @Test func `resolve tls fingerprint ignores blank or non string values`() {
        let blank: [String: Any] = [
            "gateway": [
                "remote": [
                    "tlsFingerprint": "   ",
                ],
            ],
        ]
        let nonString: [String: Any] = [
            "gateway": [
                "remote": [
                    "tlsFingerprint": 123,
                ],
            ],
        ]

        #expect(GatewayRemoteConfig.resolveTLSFingerprint(root: blank) == nil)
        #expect(GatewayRemoteConfig.resolveTLSFingerprint(root: nonString) == nil)
    }
}
