import ConcurrencyExtras
import Foundation
import Testing
@testable import OpenClaw
@testable import OpenClawKit

private actor GatewayEndpointSourceGate {
    private var current: GatewayEndpointStore.SourceSnapshot
    private var suspendNext = false
    private var returnCapturedSource = false
    private var suspendedReadStarted = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiter: CheckedContinuation<Void, Never>?

    init(_ source: GatewayEndpointStore.SourceSnapshot) {
        self.current = source
    }

    func snapshot() async -> GatewayEndpointStore.SourceSnapshot {
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
    private func makeLaunchAgentSnapshot(
        env: [String: String],
        token: String?,
        password: String?) -> LaunchAgentPlistSnapshot
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

    @Test func `resolve gateway token prefers env and falls back to launchd`() {
        let snapshot = self.makeLaunchAgentSnapshot(
            env: ["OPENCLAW_GATEWAY_TOKEN": "launchd-token"],
            token: "launchd-token",
            password: nil)

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
        let snapshot = self.makeLaunchAgentSnapshot(
            env: ["OPENCLAW_GATEWAY_TOKEN": "launchd-token"],
            token: "launchd-token",
            password: nil)
        let root: [String: Any] = [
            "gateway": [
                "auth": [
                    "token": "${OPENCLAW_GATEWAY_TOKEN}",
                ],
            ],
        ]

        let token = GatewayEndpointStore._testResolveGatewayToken(
            isRemote: false,
            root: root,
            env: [:],
            launchdSnapshot: snapshot)
        #expect(token == "launchd-token")

        let config: GatewayConnection.Config = try (
            url: #require(URL(string: "ws://127.0.0.1:18789")),
            token: token,
            password: nil)
        let url = try GatewayEndpointStore.dashboardURL(
            for: config,
            mode: .local,
            localBasePath: "/control")
        #expect(url.absoluteString == "http://127.0.0.1:18789/control/#token=launchd-token")
    }

    @Test func `resolve gateway token skips unresolved env shorthand before launchd fallback`() {
        let snapshot = self.makeLaunchAgentSnapshot(
            env: ["OPENCLAW_GATEWAY_TOKEN": "launchd-token"],
            token: "launchd-token",
            password: nil)
        let root: [String: Any] = [
            "gateway": [
                "auth": [
                    "token": "$OPENCLAW_GATEWAY_TOKEN",
                ],
            ],
        ]

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
            token: "launchd-token",
            password: nil)
        let root: [String: Any] = [
            "gateway": [
                "auth": [
                    "token": "${CUSTOM_GATEWAY_TOKEN}",
                ],
            ],
        ]

        let token = GatewayEndpointStore._testResolveGatewayToken(
            isRemote: false,
            root: root,
            env: ["CUSTOM_GATEWAY_TOKEN": "  custom-token  "],
            launchdSnapshot: snapshot)
        #expect(token == "custom-token")
    }

    @Test func `resolve gateway token resolves env template from gateway service environment`() {
        let snapshot = self.makeLaunchAgentSnapshot(
            env: ["CUSTOM_GATEWAY_TOKEN": "  service-token  "],
            token: nil,
            password: nil)
        let root: [String: Any] = [
            "gateway": [
                "auth": [
                    "token": "${CUSTOM_GATEWAY_TOKEN}",
                ],
            ],
        ]

        let token = GatewayEndpointStore._testResolveGatewayToken(
            isRemote: false,
            root: root,
            env: ["CUSTOM_GATEWAY_TOKEN": "  "],
            launchdSnapshot: snapshot)
        #expect(token == "service-token")
    }

    @Test func `resolve gateway token keeps invalid env template as plaintext`() {
        let snapshot = self.makeLaunchAgentSnapshot(
            env: ["OPENCLAW_GATEWAY_TOKEN": "launchd-token"],
            token: "launchd-token",
            password: nil)
        let root: [String: Any] = [
            "gateway": [
                "auth": [
                    "token": "${custom_gateway_token}",
                ],
            ],
        ]

        let token = GatewayEndpointStore._testResolveGatewayToken(
            isRemote: false,
            root: root,
            env: ["custom_gateway_token": "custom-token"],
            launchdSnapshot: snapshot)
        #expect(token == "${custom_gateway_token}")
    }

    @Test func `resolve gateway token omits unresolved env template without fallback`() throws {
        let root: [String: Any] = [
            "gateway": [
                "auth": [
                    "token": "${OPENCLAW_GATEWAY_TOKEN}",
                ],
            ],
        ]

        let token = GatewayEndpointStore._testResolveGatewayToken(
            isRemote: false,
            root: root,
            env: [:],
            launchdSnapshot: nil)
        #expect(token == nil)

        let config: GatewayConnection.Config = try (
            url: #require(URL(string: "ws://127.0.0.1:18789")),
            token: token,
            password: nil)
        let url = try GatewayEndpointStore.dashboardURL(
            for: config,
            mode: .local,
            localBasePath: "/control")
        #expect(url.absoluteString == "http://127.0.0.1:18789/control/")
    }

    @Test func `resolve gateway token ignores launchd in remote mode`() {
        let snapshot = self.makeLaunchAgentSnapshot(
            env: ["OPENCLAW_GATEWAY_TOKEN": "launchd-token"],
            token: "launchd-token",
            password: nil)

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
        let snapshot = self.makeLaunchAgentSnapshot(
            env: ["OPENCLAW_GATEWAY_PASSWORD": "launchd-pass"],
            token: nil,
            password: "launchd-pass")

        let password = GatewayEndpointStore._testResolveGatewayPassword(
            isRemote: false,
            root: [:],
            env: [:],
            launchdSnapshot: snapshot)
        #expect(password == "launchd-pass")
    }

    @Test func `resolve gateway password skips unresolved env template before launchd fallback`() {
        let snapshot = self.makeLaunchAgentSnapshot(
            env: ["OPENCLAW_GATEWAY_PASSWORD": "launchd-pass"],
            token: nil,
            password: "launchd-pass")
        let root: [String: Any] = [
            "gateway": [
                "auth": [
                    "password": "${OPENCLAW_GATEWAY_PASSWORD}",
                ],
            ],
        ]

        let password = GatewayEndpointStore._testResolveGatewayPassword(
            isRemote: false,
            root: root,
            env: [:],
            launchdSnapshot: snapshot)
        #expect(password == "launchd-pass")
    }

    @Test func `resolve gateway password skips unresolved env shorthand before launchd fallback`() {
        let snapshot = self.makeLaunchAgentSnapshot(
            env: ["OPENCLAW_GATEWAY_PASSWORD": "launchd-pass"],
            token: nil,
            password: "launchd-pass")
        let root: [String: Any] = [
            "gateway": [
                "auth": [
                    "password": "$OPENCLAW_GATEWAY_PASSWORD",
                ],
            ],
        ]

        let password = GatewayEndpointStore._testResolveGatewayPassword(
            isRemote: false,
            root: root,
            env: [:],
            launchdSnapshot: snapshot)
        #expect(password == "launchd-pass")
    }

    @Test func `resolve gateway password resolves env template from gateway service environment`() {
        let snapshot = self.makeLaunchAgentSnapshot(
            env: ["CUSTOM_GATEWAY_PASSWORD": "  service-pass  "],
            token: nil,
            password: nil)
        let root: [String: Any] = [
            "gateway": [
                "auth": [
                    "password": "${CUSTOM_GATEWAY_PASSWORD}",
                ],
            ],
        ]

        let password = GatewayEndpointStore._testResolveGatewayPassword(
            isRemote: false,
            root: root,
            env: [:],
            launchdSnapshot: snapshot)
        #expect(password == "service-pass")
    }

    @Test func `connection mode resolver prefers config mode over defaults`() {
        let defaults = self.makeDefaults()
        defaults.set("remote", forKey: connectionModeKey)

        let root: [String: Any] = [
            "gateway": [
                "mode": " local ",
            ],
        ]

        let resolved = ConnectionModeResolver.resolve(root: root, defaults: defaults)
        #expect(resolved.mode == .local)
    }

    @Test func `connection mode resolver trims config mode`() {
        let defaults = self.makeDefaults()
        defaults.set("local", forKey: connectionModeKey)

        let root: [String: Any] = [
            "gateway": [
                "mode": " remote ",
            ],
        ]

        let resolved = ConnectionModeResolver.resolve(root: root, defaults: defaults)
        #expect(resolved.mode == .remote)
    }

    @Test func `connection mode resolver falls back to defaults when missing config`() {
        let defaults = self.makeDefaults()
        defaults.set("remote", forKey: connectionModeKey)

        let resolved = ConnectionModeResolver.resolve(root: [:], defaults: defaults)
        #expect(resolved.mode == .remote)
    }

    @Test func `connection mode resolver falls back to defaults on unknown config`() {
        let defaults = self.makeDefaults()
        defaults.set("local", forKey: connectionModeKey)

        let root: [String: Any] = [
            "gateway": [
                "mode": "staging",
            ],
        ]

        let resolved = ConnectionModeResolver.resolve(root: root, defaults: defaults)
        #expect(resolved.mode == .local)
    }

    @Test func `connection mode resolver prefers remote URL when mode missing`() {
        let defaults = self.makeDefaults()
        defaults.set("local", forKey: connectionModeKey)

        let root: [String: Any] = [
            "gateway": [
                "remote": [
                    "url": " ws://umbrel:18789 ",
                ],
            ],
        ]

        let resolved = ConnectionModeResolver.resolve(root: root, defaults: defaults)
        #expect(resolved.mode == .remote)
    }
}

extension GatewayEndpointStoreTests {
    @Test func `remote tunnel waits for primary app launch admission`() async {
        await TestIsolation.withUserDefaultsValues([connectionModeKey: "unconfigured"]) {
            let admitted = LockIsolated(false)
            let tunnelStarts = LockIsolated(0)
            let source = self.source(mode: .remote, transport: .ssh)
            let store = GatewayEndpointStore(deps: .init(
                token: { nil },
                password: { nil },
                localPort: { 18789 },
                remoteRouteIfRunning: { nil },
                remoteRouteIsCurrent: { _ in true },
                canStartRemoteTunnel: { admitted.withValue { $0 } },
                ensureRemoteTunnel: {
                    tunnelStarts.withValue { $0 += 1 }
                    return .init(localPort: 18789, generation: 1)
                },
                routingGenerationIsCurrent: { _ in true },
                sourceSnapshot: { source }))

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
            let store = GatewayEndpointStore(deps: .init(
                token: { nil },
                password: { nil },
                localPort: { 18789 },
                remoteRouteIfRunning: { nil },
                remoteRouteIsCurrent: { _ in true },
                canStartRemoteTunnel: { true },
                ensureRemoteTunnel: { throw CancellationError() },
                routingGenerationIsCurrent: { _ in true },
                sourceSnapshot: { await sourceGate.snapshot() }))

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

    @Test func `remote TLS fingerprint changes advance endpoint revision`() async throws {
        try await TestIsolation.withUserDefaultsValues([connectionModeKey: "unconfigured"]) {
            let url = try #require(URL(string: "wss://gateway.example.invalid"))
            let sourceA = self.source(
                mode: .remote,
                transport: .direct,
                directURL: url,
                tlsFingerprint: String(repeating: "a", count: 64))
            let sourceGate = GatewayEndpointSourceGate(sourceA)
            let store = GatewayEndpointStore(deps: .init(
                token: { nil },
                password: { nil },
                localPort: { 18789 },
                remoteRouteIfRunning: { nil },
                remoteRouteIsCurrent: { _ in true },
                canStartRemoteTunnel: { true },
                ensureRemoteTunnel: { throw CancellationError() },
                routingGenerationIsCurrent: { _ in true },
                sourceSnapshot: { await sourceGate.snapshot() }))

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
                let store = GatewayEndpointStore(deps: .init(
                    token: { nil },
                    password: { nil },
                    localPort: { 18789 },
                    remoteRouteIfRunning: { nil },
                    remoteRouteIsCurrent: { _ in true },
                    canStartRemoteTunnel: { true },
                    ensureRemoteTunnel: { throw CancellationError() },
                    routingGenerationIsCurrent: { _ in true },
                    sourceSnapshot: { source }))

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
            let store = GatewayEndpointStore(deps: .init(
                token: { nil },
                password: { nil },
                localPort: { 18789 },
                remoteRouteIfRunning: { await routeGate.lookup() },
                remoteRouteIsCurrent: { _ in true },
                canStartRemoteTunnel: { true },
                ensureRemoteTunnel: { throw CancellationError() },
                routingGenerationIsCurrent: { _ in true },
                sourceSnapshot: { await sourceGate.snapshot() }))

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
            let store = GatewayEndpointStore(deps: .init(
                token: { nil },
                password: { nil },
                localPort: { 18789 },
                remoteRouteIfRunning: { nil },
                remoteRouteIsCurrent: { _ in true },
                canStartRemoteTunnel: { true },
                ensureRemoteTunnel: { throw CancellationError() },
                routingGenerationIsCurrent: { generation in
                    currentRoutingGeneration.withValue { $0 == generation }
                },
                sourceSnapshot: { await sourceGate.snapshot() }))

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
            let store = GatewayEndpointStore(deps: .init(
                token: { nil },
                password: { nil },
                localPort: { 18789 },
                remoteRouteIfRunning: { nil },
                remoteRouteIsCurrent: { _ in true },
                canStartRemoteTunnel: { true },
                ensureRemoteTunnel: { throw CancellationError() },
                routingGenerationIsCurrent: { _ in true },
                sourceSnapshot: { await sourceGate.snapshot() }))

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
            let store = GatewayEndpointStore(deps: .init(
                token: { "local-token" },
                password: { nil },
                localPort: { 18789 },
                remoteRouteIfRunning: { nil },
                remoteRouteIsCurrent: { _ in true },
                canStartRemoteTunnel: { true },
                ensureRemoteTunnel: { throw CancellationError() },
                routingGenerationIsCurrent: { _ in true },
                sourceSnapshot: { await sourceGate.snapshot() }))
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
            let store = GatewayEndpointStore(deps: .init(
                token: { nil },
                password: { nil },
                localPort: { 18789 },
                remoteRouteIfRunning: { nil },
                remoteRouteIsCurrent: { _ in true },
                canStartRemoteTunnel: { true },
                ensureRemoteTunnel: { throw CancellationError() },
                routingGenerationIsCurrent: { _ in true },
                sourceSnapshot: { await sourceGate.snapshot() }))
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
            let store = GatewayEndpointStore(deps: .init(
                token: { nil },
                password: { nil },
                localPort: { 18789 },
                remoteRouteIfRunning: { await remoteGate.routeIfRunning() },
                remoteRouteIsCurrent: { await remoteGate.isCurrent($0) },
                canStartRemoteTunnel: { true },
                ensureRemoteTunnel: { await remoteGate.ensure() },
                routingGenerationIsCurrent: { _ in true },
                sourceSnapshot: { source }))

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
            let store = GatewayEndpointStore(deps: .init(
                token: { nil },
                password: { nil },
                localPort: { 18789 },
                remoteRouteIfRunning: { await remoteGate.routeIfRunning() },
                remoteRouteIsCurrent: { await remoteGate.isCurrent($0) },
                canStartRemoteTunnel: { true },
                ensureRemoteTunnel: { await remoteGate.ensure() },
                routingGenerationIsCurrent: { _ in true },
                sourceSnapshot: { source }))

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
        let config: GatewayConnection.Config = try (
            url: #require(URL(string: "ws://127.0.0.1:18789")),
            token: nil,
            password: nil)

        let url = try GatewayEndpointStore.dashboardURL(
            for: config,
            mode: .local,
            localBasePath: " control ")
        #expect(url.absoluteString == "http://127.0.0.1:18789/control/")
    }

    @Test func `dashboard URL skips local base path in remote mode`() throws {
        let config: GatewayConnection.Config = try (
            url: #require(URL(string: "ws://gateway.example:18789")),
            token: nil,
            password: nil)

        let url = try GatewayEndpointStore.dashboardURL(
            for: config,
            mode: .remote,
            localBasePath: "/local-ui")
        #expect(url.absoluteString == "http://gateway.example:18789/")
    }

    @Test func `dashboard URL prefers path from config URL`() throws {
        let config: GatewayConnection.Config = try (
            url: #require(URL(string: "wss://gateway.example:443/remote-ui")),
            token: nil,
            password: nil)

        let url = try GatewayEndpointStore.dashboardURL(
            for: config,
            mode: .remote,
            localBasePath: "/local-ui")
        #expect(url.absoluteString == "https://gateway.example:443/remote-ui/")
    }

    @Test func `dashboard URL uses fragment token and omits password`() throws {
        let config: GatewayConnection.Config = try (
            url: #require(URL(string: "ws://127.0.0.1:18789")),
            token: "abc123",
            password: "sekret") // pragma: allowlist secret

        let url = try GatewayEndpointStore.dashboardURL(
            for: config,
            mode: .local,
            localBasePath: "/control")
        #expect(url.absoluteString == "http://127.0.0.1:18789/control/#token=abc123")
        #expect(url.query == nil)
    }

    @Test func `dashboard URL can use native auth token override`() throws {
        let config: GatewayConnection.Config = try (
            url: #require(URL(string: "ws://127.0.0.1:18789")),
            token: nil,
            password: "sekret") // pragma: allowlist secret

        let url = try GatewayEndpointStore.dashboardURL(
            for: config,
            mode: .local,
            localBasePath: "/control",
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
