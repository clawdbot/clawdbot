import CryptoKit
import Foundation
import OpenClawIPC
import Testing
@testable import OpenClaw
@testable import OpenClawDiscovery
@testable import OpenClawKit

private final class DiscoveryConnectRequestRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var connectParams: [String: Any]?

    func record(_ message: URLSessionWebSocketTask.Message) {
        guard let params = GatewayWebSocketTestSupport.connectRequestParams(from: message) else { return }
        self.lock.lock()
        self.connectParams = params
        self.lock.unlock()
    }

    func auth() -> [String: Any]? {
        self.lock.lock()
        defer { self.lock.unlock() }
        return self.connectParams?["auth"] as? [String: Any]
    }
}

@Suite(.serialized)
@MainActor
struct GatewayDiscoverySelectionSupportTests {
    private let routeBindingKey = SymmetricKey(data: Data(repeating: 0xA5, count: 32))

    private func withIsolation<T>(
        configPath: String,
        _ body: () async throws -> T) async rethrows -> T
    {
        try await TestIsolation.withIsolatedState(
            env: ["OPENCLAW_CONFIG_PATH": configPath],
            defaults: [
                "gateway.preferredStableID": nil,
                "bridge.preferredStableID": nil,
                "gateway.preferredStableIDRouteBinding.v1": nil,
            ],
            body)
    }

    private func makeGateway(
        serviceHost: String?,
        servicePort: Int?,
        tailnetDns: String? = nil,
        sshPort: Int = 22,
        gatewayTls: Bool = false,
        gatewayDirectReachable: Bool = false,
        supportsSecureDirectTransport: Bool = false,
        stableID: String) -> GatewayDiscoveryModel.DiscoveredGateway
    {
        GatewayDiscoveryModel.DiscoveredGateway(
            displayName: "Gateway",
            serviceHost: serviceHost,
            servicePort: servicePort,
            lanHost: nil,
            tailnetDns: tailnetDns,
            sshPort: sshPort,
            gatewayPort: servicePort,
            gatewayTls: gatewayTls,
            gatewayDirectReachable: gatewayDirectReachable,
            supportsSecureDirectTransport: supportsSecureDirectTransport,
            cliPath: nil,
            stableID: stableID,
            debugID: UUID().uuidString,
            isLocal: false)
    }

    @Test func `selecting tailscale serve gateway uses secure direct transport`() async {
        let tailnetHost = "gateway-host.tailnet-example.ts.net"
        let configPath = TestIsolation.tempConfigPath()
        await self.withIsolation(configPath: configPath) {
            let state = AppState(preview: true)
            state.remoteTransport = .ssh
            state.remoteTarget = "user@old-host"

            GatewayDiscoverySelectionSupport.applyRemoteSelection(
                gateway: self.makeGateway(
                    serviceHost: tailnetHost,
                    servicePort: 443,
                    tailnetDns: tailnetHost,
                    gatewayTls: true,
                    supportsSecureDirectTransport: true,
                    stableID: "tailscale-serve|\(tailnetHost)"),
                state: state)

            #expect(state.remoteTransport == .direct)
            #expect(state.remoteUrl == "wss://\(tailnetHost)")
            #expect(CommandResolver.parseSSHTarget(state.remoteTarget)?.host == tailnetHost)
        }
    }

    @Test func `combined wide area and tailscale serve discovery retains secure direct transport`() async throws {
        let tailnetHost = "gateway-host.tailnet-example.ts.net"
        let configPath = TestIsolation.tempConfigPath()
        try await self.withIsolation(configPath: configPath) {
            let wideArea = self.makeGateway(
                serviceHost: tailnetHost,
                servicePort: 443,
                tailnetDns: tailnetHost,
                gatewayTls: true,
                stableID: "wide-area|openclaw.internal.|gateway-host")
            let tailscaleServe = self.makeGateway(
                serviceHost: tailnetHost,
                servicePort: 443,
                tailnetDns: tailnetHost,
                gatewayTls: true,
                supportsSecureDirectTransport: true,
                stableID: "tailscale-serve|\(tailnetHost)")
            let deduped = GatewayDiscoveryModel.sortedDeduped(gateways: [wideArea, tailscaleServe])
            #expect(deduped.count == 1)
            let selected = try #require(deduped.first)
            let state = AppState(preview: true)
            state.remoteTransport = .ssh

            GatewayDiscoverySelectionSupport.applyRemoteSelection(gateway: selected, state: state)

            #expect(selected.stableID == tailscaleServe.stableID)
            #expect(state.remoteTransport == .direct)
            #expect(state.remoteUrl == "wss://\(tailnetHost)")
        }
    }

    @Test func `selecting wide area tailnet gateway keeps SSH transport`() async {
        let tailnetHost = "gateway-host.tailnet-example.ts.net"
        let configPath = TestIsolation.tempConfigPath()
        await self.withIsolation(configPath: configPath) {
            let state = AppState(preview: true)
            state.remoteTransport = .ssh

            GatewayDiscoverySelectionSupport.applyRemoteSelection(
                gateway: self.makeGateway(
                    serviceHost: tailnetHost,
                    servicePort: 443,
                    tailnetDns: tailnetHost,
                    gatewayTls: true,
                    stableID: "wide-area|openclaw.internal.|gateway-host"),
                state: state)

            #expect(state.remoteTransport == .ssh)
            #expect(state.remoteUrl == "ws://127.0.0.1:18789")
        }
    }

    @Test func `legacy tailnet discovery keeps SSH transport`() async {
        let tailnetHost = "gateway-host.tailnet-example.ts.net"
        let configPath = TestIsolation.tempConfigPath()
        await self.withIsolation(configPath: configPath) {
            let state = AppState(preview: true)
            state.remoteTransport = .ssh

            GatewayDiscoverySelectionSupport.applyRemoteSelection(
                gateway: self.makeGateway(
                    serviceHost: tailnetHost,
                    servicePort: 18789,
                    tailnetDns: tailnetHost,
                    stableID: "wide-area|openclaw.internal.|gateway-host"),
                state: state)

            #expect(state.remoteTransport == .ssh)
            #expect(state.remoteUrl == "ws://127.0.0.1:18789")
        }
    }

    @Test func `selecting nearby lan gateway keeps ssh without direct reachability signal`() async {
        let configPath = TestIsolation.tempConfigPath()
        await self.withIsolation(configPath: configPath) {
            let state = AppState(preview: true)
            state.remoteTransport = .ssh
            state.remoteTarget = "user@old-host"
            state.remoteUrl = "ws://localhost:29876"

            GatewayDiscoverySelectionSupport.applyRemoteSelection(
                gateway: self.makeGateway(
                    serviceHost: "nearby-gateway.local",
                    servicePort: 18789,
                    stableID: "bonjour|nearby-gateway"),
                state: state)

            #expect(state.remoteTransport == .ssh)
            #expect(state.remoteUrl == "ws://127.0.0.1:29876")
            #expect(CommandResolver.parseSSHTarget(state.remoteTarget)?.host == "nearby-gateway.local")
        }
    }

    @Test func `Bonjour direct reachability flag keeps SSH`() async {
        let configPath = TestIsolation.tempConfigPath()
        await self.withIsolation(configPath: configPath) {
            let state = AppState(preview: true)
            state.remoteTransport = .ssh
            state.remoteUrl = "ws://localhost:29876"

            GatewayDiscoverySelectionSupport.applyRemoteSelection(
                gateway: self.makeGateway(
                    serviceHost: "nearby-gateway.local",
                    servicePort: 19999,
                    gatewayDirectReachable: true,
                    stableID: "bonjour|nearby-gateway-custom"),
                state: state)

            #expect(state.remoteTransport == .ssh)
            #expect(state.remoteUrl == "ws://127.0.0.1:29876")
        }
    }

    @Test func `Bonjour TLS flag keeps SSH`() async {
        let configPath = TestIsolation.tempConfigPath()
        await self.withIsolation(configPath: configPath) {
            let state = AppState(preview: true)
            state.remoteTransport = .ssh

            GatewayDiscoverySelectionSupport.applyRemoteSelection(
                gateway: self.makeGateway(
                    serviceHost: "nearby-gateway.local",
                    servicePort: 443,
                    gatewayTls: true,
                    stableID: "bonjour|nearby-gateway-tls"),
                state: state)

            #expect(state.remoteTransport == .ssh)
            #expect(state.remoteUrl == "ws://127.0.0.1:18789")
        }
    }

    @Test func `different discovery route atomically clears config credentials and fences ambient auth`() async {
        let configPath = TestIsolation.tempConfigPath()
        defer { try? FileManager.default.removeItem(atPath: configPath) }
        await TestIsolation.withIsolatedState(
            env: [
                "OPENCLAW_CONFIG_PATH": configPath,
                "OPENCLAW_GATEWAY_TOKEN": "ambient-token",
                "OPENCLAW_GATEWAY_PASSWORD": "ambient-password",
            ],
            defaults: [
                "gateway.preferredStableID": nil,
                "bridge.preferredStableID": nil,
                "gateway.preferredStableIDRouteBinding.v1": nil,
            ])
        {
            #expect(OpenClawConfigFile.saveDict([
                "gateway": [
                    "mode": "remote",
                    "remote": [
                        "transport": "ssh",
                        "url": "ws://127.0.0.1:18789",
                        "sshTarget": "\(NSUserName())@gateway-a.local",
                        "token": "gateway-a-token",
                        "password": "gateway-a-password",
                    ],
                ],
            ]))
            let state = AppState(preview: true)
            state._testEnableGatewayConfigSync()

            GatewayDiscoverySelectionSupport.applyRemoteSelection(
                gateway: self.makeGateway(
                    serviceHost: "attacker.local",
                    servicePort: 18789,
                    stableID: "bonjour|gateway-a"),
                state: state)

            await state._testAwaitGatewayConfigSync()
            let persistedRemote = (OpenClawConfigFile.loadDict()["gateway"] as? [String: Any])?["remote"]
                as? [String: Any]
            #expect(persistedRemote?["token"] == nil)
            #expect(persistedRemote?["password"] == nil)
            #expect(CommandResolver.parseSSHTarget(state.remoteTarget)?.host == "attacker.local")

            var source = await GatewayEndpointStore._testLiveSourceSnapshot(
                state: state,
                beforeConfigRead: {})
            #expect(source.token == nil)
            #expect(source.password == nil)
            let connectAuth = try await self.connectAuth(source: source)
            #expect(connectAuth?["token"] == nil)
            #expect(connectAuth?["password"] == nil)

            var root = OpenClawConfigFile.loadDict()
            var gateway = root["gateway"] as? [String: Any] ?? [:]
            var remote = gateway["remote"] as? [String: Any] ?? [:]
            remote["password"] = "attacker-password"
            gateway["remote"] = remote
            root["gateway"] = gateway
            #expect(OpenClawConfigFile.saveDict(root))
            state._testApplyConfigFromDisk()
            source = await GatewayEndpointStore._testLiveSourceSnapshot(
                state: state,
                beforeConfigRead: {})
            #expect(source.token == nil)
            #expect(source.password == "attacker-password")

            GatewayDiscoveryPreferences.setPreferredStableID(nil)
            remote.removeValue(forKey: "password")
            gateway["remote"] = remote
            root["gateway"] = gateway
            #expect(OpenClawConfigFile.saveDict(root))
            state._testApplyConfigFromDisk()
            source = await GatewayEndpointStore._testLiveSourceSnapshot(
                state: state,
                beforeConfigRead: {})
            #expect(source.token == "ambient-token")
            #expect(source.password == "ambient-password")
        }
    }

    @Test func `same discovery route preserves its active token`() async {
        let configPath = TestIsolation.tempConfigPath()
        await self.withIsolation(configPath: configPath) {
            let state = AppState(preview: true)
            state.connectionMode = .remote
            state.remoteTransport = .ssh
            state.remoteTarget = "\(NSUserName())@gateway-a.local"
            state.remoteToken = "gateway-a-token"
            let routeBinding = GatewayDiscoveryPreferences.routeBinding(
                connectionMode: .remote,
                remoteTransport: .ssh,
                remoteURL: state.remoteUrl,
                remoteTarget: state.remoteTarget)
            GatewayDiscoveryPreferences.setPreferredStableID(
                "bonjour|gateway-a",
                routeBinding: routeBinding,
                key: self.routeBindingKey)

            GatewayDiscoverySelectionSupport.applyRemoteSelection(
                gateway: self.makeGateway(
                    serviceHost: "gateway-a.local",
                    servicePort: 18789,
                    stableID: "bonjour|gateway-a"),
                state: state,
                routeBindingKey: self.routeBindingKey)

            #expect(state.remoteToken == "gateway-a-token")
        }
    }

    @Test func `route binding is persisted only as a domain separated verifier`() async throws {
        let configPath = TestIsolation.tempConfigPath()
        try await self.withIsolation(configPath: configPath) {
            let routeBinding = "remote:direct:wss://gateway-a.example.test:443"
            GatewayDiscoveryPreferences.setPreferredStableID(
                "gateway-a",
                routeBinding: routeBinding,
                key: self.routeBindingKey)

            let verifier = try #require(GatewayDiscoveryPreferences.preferredRouteBindingVerifier())
            #expect(verifier.hasPrefix("hmac-sha256:gateway-discovery-route-binding:v1:"))
            #expect(!verifier.contains(routeBinding))
            #expect(GatewayDiscoveryPreferences.preferredRouteBindingVerification(
                routeBinding,
                key: self.routeBindingKey) == .match)
            #expect(GatewayDiscoveryPreferences.preferredRouteBindingVerification(
                "remote:direct:wss://gateway-b.example.test:443",
                key: self.routeBindingKey) == .mismatch)
            #expect(GatewayDiscoveryPreferences.preferredRouteBindingVerification(
                routeBinding,
                key: nil) == .unverifiable)
        }
    }

    @Test func `stored device auth owner requires a verified discovery receipt`() async throws {
        let configPath = TestIsolation.tempConfigPath()
        try await self.withIsolation(configPath: configPath) {
            let routeBinding = "remote:direct:wss://gateway-a.example.test:443"

            #expect(GatewayDiscoveryPreferences.authorizedDeviceAuthGatewayID(
                routeBinding,
                key: nil) == routeBinding)

            GatewayDiscoveryPreferences.setPreferredStableID(
                "gateway-a",
                routeBinding: routeBinding,
                key: self.routeBindingKey)
            #expect(GatewayDiscoveryPreferences.authorizedDeviceAuthGatewayID(
                routeBinding,
                key: self.routeBindingKey) == routeBinding)
            #expect(GatewayDiscoveryPreferences.authorizedDeviceAuthGatewayID(
                routeBinding,
                key: nil) == nil)

            for verifier in [
                routeBinding,
                "hmac-sha256:gateway-discovery-route-binding:v1:not-a-valid-tag",
            ] {
                AppDefaults.standard.set(
                    verifier,
                    forKey: "gateway.preferredStableIDRouteBinding.v1")
                #expect(GatewayDiscoveryPreferences.authorizedDeviceAuthGatewayID(
                    routeBinding,
                    key: self.routeBindingKey) == nil)
            }
        }
    }

    @Test func `unverified discovery receipt cannot reach Node connect auth`() async throws {
        let configPath = TestIsolation.tempConfigPath()
        try await self.withIsolation(configPath: configPath) {
            let gatewayURL = "wss://gateway-a.example.test"
            #expect(OpenClawConfigFile.saveDict([
                "gateway": [
                    "mode": "remote",
                    "remote": [
                        "transport": "direct",
                        "url": gatewayURL,
                    ],
                ],
            ]))
            let state = AppState(preview: true)
            let routeBinding = try #require(GatewayDiscoveryPreferences.deviceAuthGatewayID(
                connectionMode: .remote,
                remoteTransport: .direct,
                remoteURL: gatewayURL,
                remoteTarget: ""))
            GatewayDiscoveryPreferences.setPreferredStableID("gateway-a")
            AppDefaults.standard.set(
                routeBinding,
                forKey: "gateway.preferredStableIDRouteBinding.v1")

            let stateDir = FileManager.default.temporaryDirectory
                .appendingPathComponent(UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: stateDir, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: stateDir) }

            try await DeviceIdentityStore.withStateDirectory(stateDir) {
                let identity = DeviceIdentityStore.loadOrCreate()
                _ = DeviceAuthStore.storeToken(
                    deviceId: identity.deviceId,
                    role: "node",
                    token: "legacy-node-token")
                _ = DeviceAuthStore.storeToken(
                    deviceId: identity.deviceId,
                    role: "node",
                    token: "gateway-a-node-token",
                    gatewayID: routeBinding)

                var source = await GatewayEndpointStore._testLiveSourceSnapshot(
                    state: state,
                    beforeConfigRead: {})
                #expect(source.deviceAuthGatewayID == nil)
                #expect(try await self.connectNodeAuth(source: source)?["token"] == nil)

                GatewayDiscoveryPreferences.setPreferredStableID(nil)
                source = await GatewayEndpointStore._testLiveSourceSnapshot(
                    state: state,
                    beforeConfigRead: {})
                #expect(source.deviceAuthGatewayID == routeBinding)
                #expect(try await self.connectNodeAuth(source: source)?["token"] as? String ==
                    "gateway-a-node-token")
            }
        }
    }

    @Test func `legacy raw route binding is never accepted as proof`() async {
        let configPath = TestIsolation.tempConfigPath()
        await self.withIsolation(configPath: configPath) {
            let routeBinding = "remote:direct:ws://gateway-a.local:18789"
            GatewayDiscoveryPreferences.setPreferredStableID("bonjour|gateway-a")
            AppDefaults.standard.set(
                routeBinding,
                forKey: "gateway.preferredStableIDRouteBinding.v1")

            #expect(GatewayDiscoveryPreferences.preferredRouteBindingVerification(
                routeBinding,
                key: self.routeBindingKey) == .unverifiable)
        }
    }

    @Test func `background startup preserves configured auth while fencing unverified owners`() async throws {
        let configPath = TestIsolation.tempConfigPath()
        defer { try? FileManager.default.removeItem(atPath: configPath) }
        try await TestIsolation.withIsolatedState(
            env: [
                "OPENCLAW_CONFIG_PATH": configPath,
                "OPENCLAW_GATEWAY_TOKEN": "ambient-token",
                "OPENCLAW_GATEWAY_PASSWORD": "ambient-password",
            ],
            defaults: [
                "gateway.preferredStableID": nil,
                "bridge.preferredStableID": nil,
                "gateway.preferredStableIDRouteBinding.v1": nil,
            ])
        {
            let root: [String: Any] = [
                "gateway": [
                    "mode": "remote",
                    "remote": [
                        "transport": "direct",
                        "url": "wss://gateway-a.example.test",
                        "token": "configured-token",
                        "password": "configured-password",
                    ],
                ],
            ]
            #expect(OpenClawConfigFile.saveDict(root))
            GatewayDiscoveryPreferences.setPreferredStableID("gateway-a")
            AppDefaults.standard.set(
                "legacy-raw-route",
                forKey: "gateway.preferredStableIDRouteBinding.v1")
            var saveCount = 0

            let startup = GatewayDiscoveryPreferences.prepareStartupConfig(
                isPreview: false,
                saver: { _ in
                    saveCount += 1
                    return true
                },
                key: nil,
                keyAccessAllowed: false)

            #expect(!startup.migrationChanged)
            #expect(startup.migrationPersisted)
            #expect(saveCount == 0)
            #expect(GatewayRemoteConfig.resolveTokenString(root: startup.root) == "configured-token")
            let remote = try #require(
                (startup.root["gateway"] as? [String: Any])?["remote"] as? [String: Any])
            #expect(remote["password"] as? String == "configured-password")
            #expect(GatewayRemoteConfig.resolveTransport(root: startup.root) == .direct)

            let state = AppState(preview: true)
            let source = await GatewayEndpointStore._testLiveSourceSnapshot(
                state: state,
                beforeConfigRead: {})
            #expect(source.token == "configured-token")
            #expect(source.password == "configured-password")
            #expect(source.deviceAuthGatewayID == nil)

            let operatorAuth = try await self.connectAuth(source: source)
            #expect(operatorAuth?["token"] as? String == "configured-token")
            #expect(operatorAuth?["password"] as? String == "configured-password")
            let nodeAuth = try await self.connectNodeAuth(source: source)
            #expect(nodeAuth?["token"] as? String == "configured-token")
            #expect(nodeAuth?["password"] as? String == "configured-password")
        }
    }

    @Test func `config route replacement retires stale owner before stored auth`() async throws {
        let configPath = TestIsolation.tempConfigPath()
        try await self.withIsolation(configPath: configPath) {
            #expect(OpenClawConfigFile.saveDict([
                "gateway": [
                    "mode": "remote",
                    "remote": [
                        "transport": "direct",
                        "url": "wss://gateway-a.example.test",
                    ],
                ],
            ]))
            let state = AppState(preview: true)
            GatewayDiscoveryPreferences.setPreferredStableID("gateway-a")
            AppDefaults.standard.set(
                "legacy-raw-route",
                forKey: "gateway.preferredStableIDRouteBinding.v1")
            let oldRouteBinding = try #require(GatewayDiscoveryPreferences.deviceAuthGatewayID(
                connectionMode: .remote,
                remoteTransport: .direct,
                remoteURL: "wss://gateway-a.example.test",
                remoteTarget: ""))
            let newRouteBinding = try #require(GatewayDiscoveryPreferences.deviceAuthGatewayID(
                connectionMode: .remote,
                remoteTransport: .direct,
                remoteURL: "wss://gateway-b.example.test",
                remoteTarget: ""))
            let stateDir = FileManager.default.temporaryDirectory
                .appendingPathComponent(UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: stateDir, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: stateDir) }

            try await DeviceIdentityStore.withStateDirectory(stateDir) {
                let identity = DeviceIdentityStore.loadOrCreate()
                for role in ["operator", "node"] {
                    _ = DeviceAuthStore.storeToken(
                        deviceId: identity.deviceId,
                        role: role,
                        token: "legacy-\(role)-token")
                    _ = DeviceAuthStore.storeToken(
                        deviceId: identity.deviceId,
                        role: role,
                        token: "gateway-a-\(role)-token",
                        gatewayID: oldRouteBinding)
                    _ = DeviceAuthStore.storeToken(
                        deviceId: identity.deviceId,
                        role: role,
                        token: "gateway-b-\(role)-token",
                        gatewayID: newRouteBinding)
                }
                var source = await GatewayEndpointStore._testLiveSourceSnapshot(
                    state: state,
                    beforeConfigRead: {})
                #expect(source.deviceAuthGatewayID == nil)
                #expect(try await self.connectAuth(source: source)?["token"] == nil)
                #expect(try await self.connectNodeAuth(source: source)?["token"] == nil)

                #expect(OpenClawConfigFile.saveDict([
                    "gateway": [
                        "mode": "remote",
                        "remote": [
                            "transport": "direct",
                            "url": "wss://gateway-b.example.test",
                        ],
                    ],
                ]))
                state._testApplyConfigFromDisk()

                #expect(GatewayDiscoveryPreferences.preferredStableID() == nil)
                source = await GatewayEndpointStore._testLiveSourceSnapshot(
                    state: state,
                    beforeConfigRead: {})
                #expect(source.deviceAuthGatewayID == newRouteBinding)
                #expect(try await self.connectAuth(source: source)?["token"] as? String ==
                    "gateway-b-operator-token")
                #expect(try await self.connectNodeAuth(source: source)?["token"] as? String ==
                    "gateway-b-node-token")
            }
        }
    }

    @Test func `legacy discovery direct config is sanitized before hydration`() async throws {
        let configPath = TestIsolation.tempConfigPath()
        try await self.withIsolation(configPath: configPath) {
            let root: [String: Any] = [
                "gateway": [
                    "mode": "remote",
                    "remote": [
                        "transport": "direct",
                        "url": "ws://gateway-a.local:18789",
                        "sshTarget": "user@gateway-a.local",
                        "token": "legacy-token",
                        "password": "legacy-password",
                    ],
                ],
            ]
            #expect(OpenClawConfigFile.saveDict(root))
            let legacyBinding = try #require(GatewayDiscoveryPreferences.routeBinding(
                connectionMode: .remote,
                remoteTransport: .direct,
                remoteURL: "ws://gateway-a.local:18789",
                remoteTarget: "user@gateway-a.local"))
            GatewayDiscoveryPreferences.setPreferredStableID("bonjour|gateway-a")
            AppDefaults.standard.set(
                legacyBinding,
                forKey: "gateway.preferredStableIDRouteBinding.v1")

            let startup = GatewayDiscoveryPreferences.prepareStartupConfig(
                isPreview: false,
                saver: { OpenClawConfigFile.saveDict($0) },
                key: self.routeBindingKey)

            #expect(startup.migrationChanged)
            #expect(startup.migrationPersisted)
            let remote = try #require(
                (startup.root["gateway"] as? [String: Any])?["remote"] as? [String: Any])
            #expect(remote["transport"] as? String == "ssh")
            #expect(remote["url"] as? String == "ws://127.0.0.1:18789")
            #expect(remote["token"] == nil)
            #expect(remote["password"] == nil)
            #expect(GatewayDiscoveryPreferences.preferredRouteBindingVerification(
                GatewayDiscoveryPreferences.routeBinding(
                    connectionMode: .remote,
                    remoteTransport: .ssh,
                    remoteURL: "ws://127.0.0.1:18789",
                    remoteTarget: "user@gateway-a.local"),
                key: self.routeBindingKey) == .match)
        }
    }

    @Test func `failed legacy migration persistence remains unavailable`() async throws {
        let configPath = TestIsolation.tempConfigPath()
        try await self.withIsolation(configPath: configPath) {
            let root: [String: Any] = [
                "gateway": [
                    "mode": "remote",
                    "remote": [
                        "transport": "direct",
                        "url": "ws://gateway-a.local:18789",
                        "token": "legacy-token",
                    ],
                ],
            ]
            #expect(OpenClawConfigFile.saveDict(root))
            GatewayDiscoveryPreferences.setPreferredStableID("bonjour|gateway-a")
            AppDefaults.standard.set(
                "legacy-raw-route",
                forKey: "gateway.preferredStableIDRouteBinding.v1")

            let startup = GatewayDiscoveryPreferences.prepareStartupConfig(
                isPreview: false,
                saver: { _ in false },
                key: self.routeBindingKey)

            #expect(startup.migrationChanged)
            #expect(!startup.migrationPersisted)
            let inMemoryRemote = try #require(
                (startup.root["gateway"] as? [String: Any])?["remote"] as? [String: Any])
            #expect(inMemoryRemote["transport"] as? String == "ssh")
            #expect(inMemoryRemote["token"] == nil)
            #expect(GatewayRemoteConfig.resolveTokenString(root: OpenClawConfigFile.loadDict()) == "legacy-token")
        }
    }

    @Test func `manual direct config is unchanged without a discovery receipt`() async {
        let configPath = TestIsolation.tempConfigPath()
        await self.withIsolation(configPath: configPath) {
            let root: [String: Any] = [
                "gateway": [
                    "mode": "remote",
                    "remote": [
                        "transport": "direct",
                        "url": "wss://manual.example.test",
                        "token": "manual-token",
                    ],
                ],
            ]
            #expect(OpenClawConfigFile.saveDict(root))
            var saveCount = 0

            let startup = GatewayDiscoveryPreferences.prepareStartupConfig(
                isPreview: false,
                saver: { _ in
                    saveCount += 1
                    return true
                },
                key: self.routeBindingKey)

            #expect(!startup.migrationChanged)
            #expect(startup.migrationPersisted)
            #expect(saveCount == 0)
            #expect(GatewayRemoteConfig.resolveTransport(root: startup.root) == .direct)
            #expect(GatewayRemoteConfig.resolveTokenString(root: startup.root) == "manual-token")
        }
    }

    @Test func `legacy exact tailscale serve route keeps direct transport but drops credentials`() async {
        let tailnetHost = "gateway-host.tailnet-example.ts.net"
        let configPath = TestIsolation.tempConfigPath()
        await self.withIsolation(configPath: configPath) {
            let root: [String: Any] = [
                "gateway": [
                    "mode": "remote",
                    "remote": [
                        "transport": "direct",
                        "url": "wss://\(tailnetHost)",
                        "token": "legacy-token",
                        "password": "legacy-password",
                    ],
                ],
            ]
            #expect(OpenClawConfigFile.saveDict(root))
            GatewayDiscoveryPreferences.setPreferredStableID("tailscale-serve|\(tailnetHost)")
            AppDefaults.standard.set(
                "legacy-raw-route",
                forKey: "gateway.preferredStableIDRouteBinding.v1")

            let startup = GatewayDiscoveryPreferences.prepareStartupConfig(
                isPreview: false,
                saver: { OpenClawConfigFile.saveDict($0) },
                key: self.routeBindingKey)

            let remote = (startup.root["gateway"] as? [String: Any])?["remote"] as? [String: Any]
            #expect(remote?["transport"] as? String == "direct")
            #expect(remote?["url"] as? String == "wss://\(tailnetHost)")
            #expect(remote?["token"] == nil)
            #expect(remote?["password"] == nil)
        }
    }

    private func connectAuth(source: GatewayEndpointStore.SourceSnapshot) async throws -> [String: Any]? {
        let recorder = DiscoveryConnectRequestRecorder()
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                recorder.record(message)
                guard sendIndex > 0,
                      let id = GatewayWebSocketTestSupport.requestID(from: message)
                else { return }
                task.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
            })
        })
        let endpointURL = source.directRemoteURL ?? URL(string: "ws://127.0.0.1:18789")!
        let connection = GatewayConnection(
            testEndpointProvider: {
                GatewayConnection.EndpointSnapshot(
                    config: (endpointURL, source.token, source.password),
                    routeAuthority: nil,
                    deviceAuthGatewayID: source.deviceAuthGatewayID)
            },
            sessionBox: WebSocketSessionBox(session: session))
        _ = try await connection.request(
            method: "health",
            params: nil,
            retryTransportFailures: false)
        await connection.shutdown()
        return recorder.auth()
    }

    private func connectNodeAuth(
        source: GatewayEndpointStore.SourceSnapshot) async throws -> [String: Any]?
    {
        let recorder = DiscoveryConnectRequestRecorder()
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { _, message, sendIndex in
                guard sendIndex == 0 else { return }
                recorder.record(message)
            })
        })
        let endpoint = GatewayConnection.EndpointSnapshot(
            config: (
                source.directRemoteURL ?? URL(string: "ws://127.0.0.1:18789")!,
                source.token,
                source.password),
            routeAuthority: nil,
            deviceAuthGatewayID: source.deviceAuthGatewayID)
        let options = MacNodeModeCoordinator.connectOptions(
            GatewayConnectOptions(
                role: "node",
                scopes: [],
                caps: [],
                commands: [],
                permissions: [:],
                clientId: "openclaw-macos",
                clientMode: "node",
                clientDisplayName: "macOS Test",
                deviceIdentityProfile: .primary),
            for: endpoint)
        let gateway = GatewayNodeSession()
        try await gateway.connect(
            url: endpoint.config.url,
            credentials: .init(),
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: session),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { request in BridgeInvokeResponse(id: request.id, ok: true) })
        await gateway.disconnect()
        return recorder.auth()
    }
}
