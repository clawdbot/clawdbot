import Foundation
import Testing
@testable import OpenClaw

private struct StoredGatewayPreference {
    let stableID: String?
    let routeBinding: String?
}

private func captureGatewayPreference() -> StoredGatewayPreference {
    StoredGatewayPreference(
        stableID: GatewayDiscoveryPreferences.preferredStableID(),
        routeBinding: GatewayDiscoveryPreferences.preferredRouteBinding())
}

private func restoreGatewayPreference(_ preference: StoredGatewayPreference) {
    GatewayDiscoveryPreferences.setPreferredStableID(
        preference.stableID,
        routeBinding: preference.routeBinding)
}

private actor GatewayConfigReadGate {
    private var started = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiter: CheckedContinuation<Void, Never>?

    func suspendRead() async {
        self.started = true
        for waiter in self.startWaiters {
            waiter.resume()
        }
        self.startWaiters.removeAll()
        await withCheckedContinuation { continuation in
            self.releaseWaiter = continuation
        }
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

@Suite(.serialized)
@MainActor
struct AppStateRemoteConfigTests {
    @Test
    func `config fingerprint ignores writer bookkeeping metadata`() {
        let base: [String: Any] = [
            "gateway": ["mode": "local"],
        ]
        let touched: [String: Any] = [
            "gateway": ["mode": "local"],
            "meta": [
                "lastTouchedAt": "2026-07-13T09:12:53Z",
                "lastTouchedVersion": "2026.7.2",
            ],
        ]
        let changed: [String: Any] = [
            "gateway": ["mode": "remote"],
            "meta": [
                "lastTouchedAt": "2026-07-13T09:13:25Z",
                "lastTouchedVersion": "2026.7.2",
            ],
        ]

        #expect(AppState._testConfigFingerprint(base) == AppState._testConfigFingerprint(touched))
        #expect(AppState._testConfigFingerprint(base) != AppState._testConfigFingerprint(changed))
    }

    @Test
    func `route edit during config read fails the source snapshot closed`() async {
        let configPath = TestIsolation.tempConfigPath()
        await TestIsolation.withIsolatedState(
            env: ["OPENCLAW_CONFIG_PATH": configPath],
            defaults: [connectionModeKey: AppState.ConnectionMode.remote.rawValue])
        {
            #expect(OpenClawConfigFile.saveDict([
                "gateway": [
                    "mode": "remote",
                    "remote": [
                        "transport": "direct",
                        "url": "wss://gateway-a.example.test",
                        "token": "route-a-token",
                    ],
                ],
            ]))
            let state = AppState(preview: true)
            let gate = GatewayConfigReadGate()

            let read = Task {
                try await GatewayEndpointStore._testLiveSourceSnapshot(
                    state: state,
                    beforeConfigRead: { await gate.suspendRead() })
            }
            await gate.waitUntilStarted()
            state.remoteUrl = "wss://gateway-b.example.test"
            await gate.release()

            await #expect(throws: CancellationError.self) {
                try await read.value
            }
        }
    }

    @Test
    func `unbound discovery selection cannot inherit a prior route binding`() {
        let previousGatewayPreference = captureGatewayPreference()
        defer { restoreGatewayPreference(previousGatewayPreference) }
        GatewayDiscoveryPreferences.setPreferredStableID(
            "gateway-a",
            routeBinding: "remote:direct:wss://gateway-a.example.test:443")

        GatewayDiscoveryPreferences.setPreferredStableID("gateway-b")

        #expect(GatewayDiscoveryPreferences.preferredStableID() == "gateway-b")
        #expect(GatewayDiscoveryPreferences.preferredRouteBinding() == nil)
    }

    @Test
    func `invalid remote drafts cannot be persisted for a configured gateway probe`() {
        let base = AppState.GatewayConfigSyncDraft(
            connectionMode: .remote,
            remoteTransport: .direct,
            remoteTarget: "",
            remoteIdentity: "",
            remoteUrl: "not a gateway URL",
            remoteToken: "",
            dirtyFields: [])

        #expect(!AppState._testGatewayDraftCanPersist(base))
        #expect(AppState._testGatewayDraftCanPersist(.init(
            connectionMode: .remote,
            remoteTransport: .direct,
            remoteTarget: "",
            remoteIdentity: "",
            remoteUrl: "wss://gateway.example.test",
            remoteToken: "",
            dirtyFields: [])))
        #expect(!AppState._testGatewayDraftCanPersist(.init(
            connectionMode: .remote,
            remoteTransport: .ssh,
            remoteTarget: "",
            remoteIdentity: "",
            remoteUrl: "ws://127.0.0.1:18789",
            remoteToken: "",
            dirtyFields: [])))
    }

    @Test
    func `invalid remote edit retires the prior canonical gateway route`() async {
        let configPath = TestIsolation.tempConfigPath()
        await TestIsolation.withIsolatedState(
            env: ["OPENCLAW_CONFIG_PATH": configPath],
            defaults: [connectionModeKey: AppState.ConnectionMode.remote.rawValue])
        {
            #expect(OpenClawConfigFile.saveDict([
                "gateway": [
                    "mode": "remote",
                    "remote": [
                        "transport": "ssh",
                        "url": "ws://127.0.0.1:18789",
                        "sshTarget": "alice@gateway-a.example.test",
                    ],
                ],
            ]))
            let state = AppState(preview: true)
            state._testEnableGatewayConfigSync()

            state.remoteTarget = ""
            #expect(!state._testGatewayConfigIsCurrentForRouting)
            await state._testAwaitGatewayConfigSync()

            #expect(!state._testGatewayConfigIsCurrentForRouting)
            let persisted = CommandResolver.connectionSettings()
            #expect(persisted.target == "alice@gateway-a.example.test")
            #expect(GatewayEndpointStore._testEffectiveSourceMode(
                appMode: .remote,
                configMode: .remote,
                configIsCurrent: state._testGatewayConfigIsCurrentForRouting) == .unconfigured)
        }
    }

    @Test
    func `remote identity edit updates canonical SSH config before routing resumes`() async {
        let configPath = TestIsolation.tempConfigPath()
        await TestIsolation.withIsolatedState(
            env: ["OPENCLAW_CONFIG_PATH": configPath],
            defaults: [connectionModeKey: AppState.ConnectionMode.remote.rawValue])
        {
            #expect(OpenClawConfigFile.saveDict([
                "gateway": [
                    "mode": "remote",
                    "remote": [
                        "transport": "ssh",
                        "url": "ws://127.0.0.1:18789",
                        "sshTarget": "alice@gateway.example.test",
                        "sshIdentity": "/tmp/old-identity",
                    ],
                ],
            ]))
            let state = AppState(preview: true)
            state._testEnableGatewayConfigSync()

            state.remoteIdentity = " /tmp/new-identity "
            #expect(!state._testGatewayConfigIsCurrentForRouting)
            await state._testAwaitGatewayConfigSync()

            #expect(state._testGatewayConfigIsCurrentForRouting)
            let persisted = CommandResolver.connectionSettings()
            #expect(persisted.identity == "/tmp/new-identity")
            let remote = (OpenClawConfigFile.loadDict()["gateway"] as? [String: Any])?["remote"]
                as? [String: Any]
            #expect(remote?["sshIdentity"] as? String == "/tmp/new-identity")
        }
    }

    @Test(arguments: [nil, "wss://previous.example.test"] as [String?])
    func `incomplete direct URL edits survive sync until completed`(savedURL: String?) async {
        let configPath = TestIsolation.tempConfigPath()
        await TestIsolation.withIsolatedState(env: ["OPENCLAW_CONFIG_PATH": configPath]) {
            var remote: [String: Any] = ["transport": "direct"]
            remote["url"] = savedURL
            #expect(OpenClawConfigFile.saveDict(["gateway": ["mode": "remote", "remote": remote]]))
            let state = AppState(preview: true)
            state._testEnableGatewayConfigSync()

            for draft in ["w", "ws", "wss", "wss:", "wss:/", "wss://"] {
                state.remoteUrl = draft
                await state._testAwaitGatewayConfigSync()

                #expect(state.remoteUrl == draft)
                #expect(state._testDirtyGatewayConfigFields == ["gateway.remote.url"])
                #expect(!state.gatewayConfigIsCurrentForRouting)
                #expect(GatewayRemoteConfig.resolveUrlString(root: OpenClawConfigFile.loadDict()) == savedURL)
            }

            state.remoteUrl += "gateway.example.test"
            await state._testAwaitGatewayConfigSync()
            #expect(state.remoteUrl == "wss://gateway.example.test")
            #expect(state._testDirtyGatewayConfigFields.isEmpty)
            #expect(state.gatewayConfigIsCurrentForRouting)
            #expect(GatewayRemoteConfig.resolveUrlString(root: OpenClawConfigFile.loadDict()) == state.remoteUrl)
        }
    }

    @Test
    func `incomplete direct URL retains ownership across external config edits`() async {
        let configPath = TestIsolation.tempConfigPath()
        await TestIsolation.withIsolatedState(env: ["OPENCLAW_CONFIG_PATH": configPath]) {
            var remote = ["transport": "direct", "url": "wss://previous.example.test", "token": "old-token"]
            #expect(OpenClawConfigFile.saveDict(["gateway": ["mode": "remote", "remote": remote]]))
            let state = AppState(preview: true)
            state._testEnableGatewayConfigSync()
            state.remoteUrl = "wss://"
            await state._testAwaitGatewayConfigSync()

            remote["token"] = "new-token"
            #expect(OpenClawConfigFile.saveDict(["gateway": ["mode": "remote", "remote": remote]]))
            state._testApplyConfigFromDisk()
            #expect(state.remoteUrl == "wss://")
            #expect(state.remoteToken == "new-token")
            #expect(state.gatewayConfigConflict == nil)

            remote["url"] = "wss://external.example.test"
            #expect(OpenClawConfigFile.saveDict(["gateway": ["mode": "remote", "remote": remote]]))
            state._testApplyConfigFromDisk()
            #expect(state.remoteUrl == "wss://")
            #expect(state._testConflictedGatewayConfigFields == ["gateway.remote.url"])
            #expect(!state.keepGatewayConfigEdits())
            #expect(GatewayRemoteConfig.resolveUrlString(root: OpenClawConfigFile.loadDict()) == remote["url"])
            #expect(state.useFileGatewayConfigConflict())
            #expect(state.remoteUrl == remote["url"])
            #expect(state._testDirtyGatewayConfigFields.isEmpty)
            #expect(state.gatewayConfigIsCurrentForRouting)
        }
    }

    @Test
    func `successful gateway config sync clears dirty fields`() async {
        let configPath = TestIsolation.tempConfigPath()
        await TestIsolation.withIsolatedState(env: ["OPENCLAW_CONFIG_PATH": configPath]) {
            #expect(OpenClawConfigFile.saveDict([
                "gateway": [
                    "mode": "remote",
                    "remote": [
                        "transport": "direct",
                        "url": "wss://gateway.example.test",
                        "token": "disk-token",
                    ],
                ],
            ]))
            let state = AppState(preview: true)
            state._testEnableGatewayConfigSync()

            state.remoteToken = "app-token"
            #expect(state.remoteTokenDirty)
            await state._testAwaitGatewayConfigSync()

            #expect(!state.remoteTokenDirty)
            #expect(state._testDirtyGatewayConfigFields.isEmpty)
            #expect(state._testGatewayConfigIsCurrentForRouting)
            let remote = (OpenClawConfigFile.loadDict()["gateway"] as? [String: Any])?["remote"]
                as? [String: Any]
            #expect(remote?["token"] as? String == "app-token")

            state.remoteToken = " app-token "
            #expect(state.remoteTokenDirty)
            await state._testAwaitGatewayConfigSync()
            #expect(!state.remoteTokenDirty)
        }
    }

    @Test
    func `failed gateway config sync retains dirty fields`() async {
        let configPath = TestIsolation.tempConfigPath()
        await TestIsolation.withIsolatedState(env: ["OPENCLAW_CONFIG_PATH": configPath]) {
            #expect(OpenClawConfigFile.saveDict([
                "gateway": [
                    "mode": "remote",
                    "remote": [
                        "transport": "direct",
                        "url": "wss://gateway.example.test",
                        "token": "disk-token",
                    ],
                ],
            ]))
            let state = AppState(preview: true, gatewayConfigSaver: { _ in false })
            state._testEnableGatewayConfigSync()

            state.remoteToken = "app-token"
            await state._testAwaitGatewayConfigSync()

            #expect(state.remoteTokenDirty)
            #expect(state._testDirtyGatewayConfigFields == ["gateway.remote.token"])
            #expect(!state._testGatewayConfigIsCurrentForRouting)
            let remote = (OpenClawConfigFile.loadDict()["gateway"] as? [String: Any])?["remote"]
                as? [String: Any]
            #expect(remote?["token"] as? String == "disk-token")
        }
    }

    @Test
    func `config watcher adopts non-dirty remote gateway fields`() async {
        let configPath = TestIsolation.tempConfigPath()
        await TestIsolation.withIsolatedState(env: ["OPENCLAW_CONFIG_PATH": configPath]) {
            #expect(OpenClawConfigFile.saveDict([
                "gateway": [
                    "mode": "remote",
                    "remote": [
                        "transport": "direct",
                        "url": "wss://old-gateway.example.test",
                        "token": "old-token",
                    ],
                ],
            ]))
            let state = AppState(preview: true)

            #expect(OpenClawConfigFile.saveDict([
                "gateway": [
                    "mode": "remote",
                    "remote": [
                        "transport": "ssh",
                        "url": "ws://127.0.0.1:19999",
                        "sshTarget": "alice@new-gateway.example.test",
                        "sshIdentity": "/tmp/new-identity",
                        "token": "new-token",
                    ],
                ],
            ]))
            state._testApplyConfigFromDisk()

            #expect(state.remoteTransport == .ssh)
            #expect(state.remoteUrl == "ws://127.0.0.1:19999")
            #expect(state.remoteTarget == "alice@new-gateway.example.test")
            #expect(state.remoteIdentity == "/tmp/new-identity")
            #expect(state.remoteToken == "new-token")
            #expect(state._testDirtyGatewayConfigFields.isEmpty)
            #expect(state._testConflictedGatewayConfigFields.isEmpty)
        }
    }

    @Test
    func `external token edit after successful sync is not reverted`() async {
        let configPath = TestIsolation.tempConfigPath()
        await TestIsolation.withIsolatedState(env: ["OPENCLAW_CONFIG_PATH": configPath]) {
            #expect(OpenClawConfigFile.saveDict([
                "gateway": [
                    "mode": "remote",
                    "remote": [
                        "transport": "direct",
                        "url": "wss://gateway.example.test",
                        "token": "initial-token",
                    ],
                ],
            ]))
            let state = AppState(preview: true)
            state._testEnableGatewayConfigSync()

            state.remoteToken = "app-token"
            await state._testAwaitGatewayConfigSync()
            #expect(!state.remoteTokenDirty)

            var externalRoot = OpenClawConfigFile.loadDict()
            var gateway = externalRoot["gateway"] as? [String: Any] ?? [:]
            var remote = gateway["remote"] as? [String: Any] ?? [:]
            remote["token"] = "external-token"
            gateway["remote"] = remote
            externalRoot["gateway"] = gateway
            #expect(OpenClawConfigFile.saveDict(externalRoot))

            #expect(state.syncGatewayConfigNow())
            #expect(state.remoteToken == "external-token")
            let persistedRemote = (OpenClawConfigFile.loadDict()["gateway"] as? [String: Any])?["remote"]
                as? [String: Any]
            #expect(persistedRemote?["token"] as? String == "external-token")
        }
    }

    @Test
    func `dirty external token conflict offers both recovery choices`() async {
        let configPath = TestIsolation.tempConfigPath()
        await TestIsolation.withIsolatedState(env: ["OPENCLAW_CONFIG_PATH": configPath]) {
            #expect(OpenClawConfigFile.saveDict([
                "gateway": [
                    "mode": "remote",
                    "remote": [
                        "transport": "ssh",
                        "url": "ws://127.0.0.1:18789",
                        "sshTarget": "alice@gateway.example.test",
                        "sshIdentity": "/tmp/initial-identity",
                        "token": "initial-token",
                    ],
                ],
            ]))
            var rejectSaves = false
            let state = AppState(
                preview: true,
                gatewayConfigSaver: { root in
                    rejectSaves ? false : OpenClawConfigFile.saveDict(root)
                })
            state.remoteIdentity = "/tmp/app-identity"
            state.remoteToken = "app-token"

            var externalRoot = OpenClawConfigFile.loadDict()
            var gateway = externalRoot["gateway"] as? [String: Any] ?? [:]
            var remote = gateway["remote"] as? [String: Any] ?? [:]
            remote.removeValue(forKey: "sshIdentity")
            remote["token"] = "external-token"
            gateway["remote"] = remote
            externalRoot["gateway"] = gateway
            #expect(OpenClawConfigFile.saveDict(externalRoot))
            state._testApplyConfigFromDisk()

            #expect(state.remoteIdentity == "/tmp/app-identity")
            #expect(state.remoteToken == "app-token")
            #expect(state.remoteTokenDirty)
            #expect(state._testConflictedGatewayConfigFields == [
                "gateway.remote.sshIdentity",
                "gateway.remote.token",
            ])
            #expect(state.gatewayConfigConflict?.fields == [.remoteIdentity, .remoteToken])
            #expect(state.gatewayConfigConflict?.fieldNames == ["Identity file", "Gateway token"])
            #expect(state.gatewayConfigConflict?.message ==
                "These settings changed outside the app while you were editing: " +
                "Identity file and Gateway token. " +
                "Choose which version to keep.")
            #expect(!state._testGatewayConfigIsCurrentForRouting)

            state._testEnableGatewayConfigSync()
            #expect(!state.syncGatewayConfigNow())
            var persistedRemote = (OpenClawConfigFile.loadDict()["gateway"] as? [String: Any])?["remote"]
                as? [String: Any]
            #expect(persistedRemote?["token"] as? String == "external-token")
            #expect(state.remoteToken == "app-token")

            #expect(state.useFileGatewayConfigConflict())
            #expect(state.remoteIdentity.isEmpty)
            #expect(state.remoteToken == "external-token")
            #expect(!state.remoteTokenDirty)
            #expect(state.gatewayConfigConflict == nil)
            #expect(state._testConflictedGatewayConfigFields.isEmpty)
            #expect(state._testGatewayConfigIsCurrentForRouting)

            state.remoteToken = "kept-token"
            externalRoot = OpenClawConfigFile.loadDict()
            gateway = externalRoot["gateway"] as? [String: Any] ?? [:]
            remote = gateway["remote"] as? [String: Any] ?? [:]
            remote["token"] = "second-external-token"
            gateway["remote"] = remote
            externalRoot["gateway"] = gateway
            #expect(OpenClawConfigFile.saveDict(externalRoot))
            state._testApplyConfigFromDisk()

            #expect(state.gatewayConfigConflict?.fields == [.remoteToken])
            #expect(state.keepGatewayConfigEdits())
            persistedRemote = (OpenClawConfigFile.loadDict()["gateway"] as? [String: Any])?["remote"]
                as? [String: Any]
            #expect(persistedRemote?["token"] as? String == "kept-token")
            #expect(state.remoteToken == "kept-token")
            #expect(!state.remoteTokenDirty)
            #expect(state.gatewayConfigConflict == nil)
            #expect(state._testConflictedGatewayConfigFields.isEmpty)
            #expect(state._testGatewayConfigIsCurrentForRouting)

            state.remoteToken = "unsaved-token"
            externalRoot = OpenClawConfigFile.loadDict()
            gateway = externalRoot["gateway"] as? [String: Any] ?? [:]
            remote = gateway["remote"] as? [String: Any] ?? [:]
            remote["token"] = "third-external-token"
            gateway["remote"] = remote
            externalRoot["gateway"] = gateway
            #expect(OpenClawConfigFile.saveDict(externalRoot))
            state._testApplyConfigFromDisk()

            rejectSaves = true
            #expect(!state.keepGatewayConfigEdits())
            persistedRemote = (OpenClawConfigFile.loadDict()["gateway"] as? [String: Any])?["remote"]
                as? [String: Any]
            #expect(persistedRemote?["token"] as? String == "third-external-token")
            #expect(state.remoteToken == "unsaved-token")
            #expect(state.gatewayConfigConflict?.fields == [.remoteToken])
            #expect(state._testConflictedGatewayConfigFields == ["gateway.remote.token"])
            #expect(!state._testGatewayConfigIsCurrentForRouting)
        }
    }

    @Test
    func `dirty token does not claim an externally changed remote URL`() async {
        let configPath = TestIsolation.tempConfigPath()
        await TestIsolation.withIsolatedState(env: ["OPENCLAW_CONFIG_PATH": configPath]) {
            #expect(OpenClawConfigFile.saveDict([
                "gateway": [
                    "mode": "remote",
                    "remote": [
                        "transport": "direct",
                        "url": "wss://old-gateway.example.test",
                        "token": "initial-token",
                    ],
                ],
            ]))
            let state = AppState(preview: true)
            state.remoteToken = "app-token"

            var externalRoot = OpenClawConfigFile.loadDict()
            var gateway = externalRoot["gateway"] as? [String: Any] ?? [:]
            var remote = gateway["remote"] as? [String: Any] ?? [:]
            remote["url"] = "wss://new-gateway.example.test"
            gateway["remote"] = remote
            externalRoot["gateway"] = gateway
            #expect(OpenClawConfigFile.saveDict(externalRoot))
            state._testApplyConfigFromDisk()

            #expect(state.remoteToken == "app-token")
            #expect(state.remoteUrl == "wss://new-gateway.example.test")
            #expect(state._testConflictedGatewayConfigFields.isEmpty)

            state._testEnableGatewayConfigSync()
            #expect(state.syncGatewayConfigNow())
            let persistedRemote = (OpenClawConfigFile.loadDict()["gateway"] as? [String: Any])?["remote"]
                as? [String: Any]
            #expect(persistedRemote?["token"] as? String == "app-token")
            #expect(persistedRemote?["url"] as? String == "wss://new-gateway.example.test")
        }
    }

    @Test
    func `config watcher endpoint replacement clears and ignores stale discovery identity`() {
        let previousGatewayPreference = captureGatewayPreference()
        let previousPending = UserDefaults.standard.object(forKey: onboardingSystemAgentPendingKey)
        defer {
            restoreGatewayPreference(previousGatewayPreference)
            if let previousPending {
                UserDefaults.standard.set(previousPending, forKey: onboardingSystemAgentPendingKey)
            } else {
                OnboardingSystemAgentResumeStore.clear()
            }
        }
        let state = AppState(preview: true)
        state._testApplyConfigOverrides([
            "gateway": [
                "mode": "remote",
                "remote": [
                    "transport": "direct",
                    "url": "wss://gateway-a.example.test",
                ],
            ],
        ])
        GatewayDiscoveryPreferences.setPreferredStableID("gateway-a")
        OnboardingSystemAgentResumeStore.markPending(routeIdentity: "remote:id:gateway-a")
        let view = OnboardingView(state: state)
        view.preferredGatewayID = "gateway-a"

        state._testApplyConfigOverrides([
            "gateway": [
                "mode": "remote",
                "remote": [
                    "transport": "direct",
                    "url": "wss://gateway-b.example.test",
                ],
            ],
        ])

        #expect(state.remoteUrl == "wss://gateway-b.example.test")
        #expect(GatewayDiscoveryPreferences.preferredStableID() == nil)
        #expect(view.effectivePreferredGatewayID == nil)
        let routeIdentity = OnboardingSystemAgentResumeStore.selectedRouteIdentity(
            state: state,
            preferredGatewayID: view.effectivePreferredGatewayID)
        #expect(routeIdentity?.hasPrefix("remote:direct:") == true)
        #expect(routeIdentity != "remote:id:gateway-a")
        #expect(!OnboardingSystemAgentResumeStore.isPending(for: routeIdentity))
        #expect(OnboardingSystemAgentResumeStore.isPending(for: "remote:id:gateway-a"))
    }

    @Test
    func `config watcher explicit ssh target replacement clears stale discovery identity`() {
        let previousGatewayPreference = captureGatewayPreference()
        defer { restoreGatewayPreference(previousGatewayPreference) }
        let state = AppState(preview: true)
        state._testApplyConfigOverrides([
            "gateway": [
                "mode": "remote",
                "remote": [
                    "transport": "ssh",
                    "url": "ws://127.0.0.1:18789",
                    "sshTarget": "alice@gateway-a.example.test",
                ],
            ],
        ])
        GatewayDiscoveryPreferences.setPreferredStableID("gateway-a")
        let view = OnboardingView(state: state)
        view.preferredGatewayID = "gateway-a"

        state._testApplyConfigOverrides([
            "gateway": [
                "mode": "remote",
                "remote": [
                    "transport": "ssh",
                    "url": "ws://127.0.0.1:18789",
                    "sshTarget": "bob@gateway-b.example.test",
                ],
            ],
        ])

        #expect(state.remoteTarget == "bob@gateway-b.example.test")
        #expect(GatewayDiscoveryPreferences.preferredStableID() == nil)
        #expect(view.effectivePreferredGatewayID == nil)
    }

    @Test
    func `config watcher explicit blank SSH fields clear stale defaults`() {
        let previousGatewayPreference = captureGatewayPreference()
        defer { restoreGatewayPreference(previousGatewayPreference) }
        let state = AppState(preview: true)
        state._testApplyConfigOverrides([
            "gateway": [
                "mode": "remote",
                "remote": [
                    "transport": "ssh",
                    "url": "ws://127.0.0.1:18789",
                    "sshTarget": "alice@gateway-a.example.test",
                    "sshIdentity": "/tmp/gateway-a-id",
                ],
            ],
        ])
        GatewayDiscoveryPreferences.setPreferredStableID("gateway-a")

        state._testApplyConfigOverrides([
            "gateway": [
                "mode": "remote",
                "remote": [
                    "transport": "ssh",
                    "url": "ws://127.0.0.1:18789",
                    "sshTarget": "   ",
                    "sshIdentity": "   ",
                ],
            ],
        ])

        #expect(state.remoteTarget.isEmpty)
        #expect(state.remoteIdentity.isEmpty)
        #expect(GatewayDiscoveryPreferences.preferredStableID() == nil)
    }

    @Test
    func `cold direct config replacement clears the prior discovery owner`() async {
        let configPath = TestIsolation.tempConfigPath()
        let previousGatewayPreference = captureGatewayPreference()
        defer { restoreGatewayPreference(previousGatewayPreference) }

        await TestIsolation.withIsolatedState(
            env: ["OPENCLAW_CONFIG_PATH": configPath],
            defaults: [connectionModeKey: AppState.ConnectionMode.remote.rawValue])
        {
            #expect(OpenClawConfigFile.saveDict([
                "gateway": [
                    "mode": "remote",
                    "remote": [
                        "transport": "direct",
                        "url": "wss://gateway-b.example.test",
                    ],
                ],
            ]))
            let oldBinding = GatewayDiscoveryPreferences.routeBinding(
                connectionMode: .remote,
                remoteTransport: .direct,
                remoteURL: "wss://gateway-a.example.test",
                remoteTarget: "")
            GatewayDiscoveryPreferences.setPreferredStableID(
                "gateway-a",
                routeBinding: oldBinding)

            let state = AppState(preview: true)

            #expect(state.remoteUrl == "wss://gateway-b.example.test")
            #expect(state._testReconcilePreferredGatewayRouteBinding())
            #expect(GatewayDiscoveryPreferences.preferredStableID() == nil)
            #expect(GatewayDiscoveryPreferences.preferredRouteBinding() == nil)
        }
    }

    @Test
    func `cold SSH config replacement overrides stale defaults and clears their owner`() async {
        let configPath = TestIsolation.tempConfigPath()
        let previousGatewayPreference = captureGatewayPreference()
        defer { restoreGatewayPreference(previousGatewayPreference) }

        await TestIsolation.withIsolatedState(
            env: ["OPENCLAW_CONFIG_PATH": configPath],
            defaults: [
                connectionModeKey: AppState.ConnectionMode.remote.rawValue,
                remoteTargetKey: "alice@gateway-a.example.test",
                remoteIdentityKey: "/tmp/gateway-a-id",
            ]) {
                #expect(OpenClawConfigFile.saveDict([
                    "gateway": [
                        "mode": "remote",
                        "remote": [
                            "transport": "ssh",
                            "url": "ws://127.0.0.1:18789",
                            "sshTarget": "bob@gateway-b.example.test",
                            "sshIdentity": "/tmp/gateway-b-id",
                        ],
                    ],
                ]))
                let oldBinding = GatewayDiscoveryPreferences.routeBinding(
                    connectionMode: .remote,
                    remoteTransport: .ssh,
                    remoteURL: "ws://127.0.0.1:18789",
                    remoteTarget: "alice@gateway-a.example.test")
                GatewayDiscoveryPreferences.setPreferredStableID(
                    "gateway-a",
                    routeBinding: oldBinding)

                let state = AppState(preview: true)
                let settings = CommandResolver.connectionSettings()

                #expect(state.remoteTarget == "bob@gateway-b.example.test")
                #expect(state.remoteIdentity == "/tmp/gateway-b-id")
                #expect(settings.target == "bob@gateway-b.example.test")
                #expect(settings.identity == "/tmp/gateway-b-id")
                #expect(state._testReconcilePreferredGatewayRouteBinding())
                #expect(GatewayDiscoveryPreferences.preferredStableID() == nil)
                #expect(GatewayDiscoveryPreferences.preferredRouteBinding() == nil)
            }
    }

    @Test
    func `cold explicit blank SSH fields clear stale defaults`() async {
        let configPath = TestIsolation.tempConfigPath()
        let previousGatewayPreference = captureGatewayPreference()
        defer { restoreGatewayPreference(previousGatewayPreference) }

        await TestIsolation.withIsolatedState(
            env: ["OPENCLAW_CONFIG_PATH": configPath],
            defaults: [
                connectionModeKey: AppState.ConnectionMode.remote.rawValue,
                remoteTargetKey: "alice@gateway-a.example.test",
                remoteIdentityKey: "/tmp/gateway-a-id",
            ]) {
                #expect(OpenClawConfigFile.saveDict([
                    "gateway": [
                        "mode": "remote",
                        "remote": [
                            "transport": "ssh",
                            "url": "ws://127.0.0.1:18789",
                            "sshTarget": "   ",
                            "sshIdentity": "   ",
                        ],
                    ],
                ]))

                let state = AppState(preview: true)
                let settings = CommandResolver.connectionSettings()

                #expect(state.remoteTarget.isEmpty)
                #expect(state.remoteIdentity.isEmpty)
                #expect(settings.target.isEmpty)
                #expect(settings.identity.isEmpty)
            }
    }
}

extension AppStateRemoteConfigTests {
    @Test
    func `updated remote gateway config sets trimmed token`() {
        let remote = AppState._testUpdatedRemoteGatewayConfig(
            current: [:],
            draft: .init(
                transport: .ssh,
                remoteUrl: "",
                remoteHost: "gateway.example",
                remoteTarget: "alice@gateway.example",
                remoteIdentity: "/tmp/id_ed25519",
                remoteToken: "  secret-token  ",
                dirtyFields: [.remoteToken]))

        #expect(remote["token"] as? String == "secret-token")
    }

    @Test
    func `updated remote gateway config clears token when blank`() {
        let remote = AppState._testUpdatedRemoteGatewayConfig(
            current: ["token": "old-token"],
            draft: .init(
                transport: .direct,
                remoteUrl: "wss://gateway.example",
                remoteHost: nil,
                remoteTarget: "",
                remoteIdentity: "",
                remoteToken: "   ",
                dirtyFields: [.remoteToken]))

        #expect((remote["token"] as? String) == nil)
    }

    @Test
    func `updated remote gateway config pins loopback url for ssh transport`() {
        let remote = AppState._testUpdatedRemoteGatewayConfig(
            current: ["url": "ws://gateway.example:18789"],
            draft: .init(
                transport: .ssh,
                remoteUrl: "",
                remoteHost: "gateway.example",
                remoteTarget: "alice@gateway.example",
                remoteIdentity: "",
                remoteToken: "",
                dirtyFields: [.remoteTransport, .remoteUrl, .remoteTarget, .remoteHostKeyPolicy]))

        #expect(remote["url"] as? String == "ws://127.0.0.1:18789")
        #expect(remote["transport"] as? String == "ssh")
        #expect(remote["sshTarget"] as? String == "alice@gateway.example")
    }

    @Test
    func `updated remote gateway config keeps OpenSSH opt in only for the same target`() {
        let sameTarget = AppState._testUpdatedRemoteGatewayConfig(
            current: [
                "sshHostKeyPolicy": "openssh",
                "sshTarget": "alice@gateway.example",
            ],
            draft: .init(
                transport: .ssh,
                remoteUrl: "",
                remoteHost: nil,
                remoteTarget: "alice@gateway.example",
                remoteIdentity: "",
                remoteToken: "",
                dirtyFields: [.remoteTarget, .remoteHostKeyPolicy]))
        let changedTarget = AppState._testUpdatedRemoteGatewayConfig(
            current: [
                "sshHostKeyPolicy": "openssh",
                "sshTarget": "old-gateway-alias",
            ],
            draft: .init(
                transport: .ssh,
                remoteUrl: "",
                remoteHost: nil,
                remoteTarget: "new-gateway-alias",
                remoteIdentity: "",
                remoteToken: "",
                dirtyFields: [.remoteTarget, .remoteHostKeyPolicy]))

        #expect(sameTarget["sshHostKeyPolicy"] as? String == "openssh")
        #expect(changedTarget["sshHostKeyPolicy"] as? String == "strict")
    }

    @Test
    func `updated remote gateway config preserves custom loopback tunnel port`() {
        let remote = AppState._testUpdatedRemoteGatewayConfig(
            current: ["url": "ws://localhost.:29876"],
            draft: .init(
                transport: .ssh,
                remoteUrl: "",
                remoteHost: "gateway.example",
                remoteTarget: "alice@gateway.example",
                remoteIdentity: "",
                remoteToken: "",
                dirtyFields: [.remoteUrl]))

        #expect(remote["url"] as? String == "ws://127.0.0.1:29876")
    }

    @Test
    func `updated remote gateway config preserves custom port when existing host matches ssh target`() {
        let remote = AppState._testUpdatedRemoteGatewayConfig(
            current: ["url": "ws://gateway.example:19999"],
            draft: .init(
                transport: .ssh,
                remoteUrl: "",
                remoteHost: nil,
                remoteTarget: "alice@gateway.example",
                remoteIdentity: "",
                remoteToken: "",
                dirtyFields: [.remoteUrl]))

        #expect(remote["url"] as? String == "ws://127.0.0.1:19999")
    }

    @Test
    func `updated remote gateway config drops custom port when existing host does not match ssh target`() {
        let remote = AppState._testUpdatedRemoteGatewayConfig(
            current: ["url": "ws://other-host.example:19999"],
            draft: .init(
                transport: .ssh,
                remoteUrl: "",
                remoteHost: "gateway.example",
                remoteTarget: "alice@gateway.example",
                remoteIdentity: "",
                remoteToken: "",
                dirtyFields: [.remoteUrl]))

        #expect(remote["url"] as? String == "ws://127.0.0.1:18789")
    }

    @Test
    func `updated remote gateway config does not preserve port for hostname prefix collision`() {
        let remote = AppState._testUpdatedRemoteGatewayConfig(
            current: ["url": "ws://example.attacker.tld:19999"],
            draft: .init(
                transport: .ssh,
                remoteUrl: "",
                remoteHost: nil,
                remoteTarget: "alice@example.com",
                remoteIdentity: "",
                remoteToken: "",
                dirtyFields: [.remoteUrl]))

        #expect(remote["url"] as? String == "ws://127.0.0.1:18789")
    }

    @Test
    func `app state init does not infer loopback host into remote target`() async {
        let configPath = TestIsolation.tempConfigPath()
        await TestIsolation.withIsolatedState(
            env: ["OPENCLAW_CONFIG_PATH": configPath],
            defaults: [remoteTargetKey: nil])
        {
            OpenClawConfigFile.saveDict([
                "gateway": [
                    "mode": "remote",
                    "remote": [
                        "url": "ws://127.0.0.1:19999",
                    ],
                ],
            ])

            let state = AppState(preview: true)
            #expect(state.remoteTarget.isEmpty)
        }
    }

    @Test
    func `app state init preserves existing remote target when remote url is loopback`() async {
        let configPath = TestIsolation.tempConfigPath()
        await TestIsolation.withIsolatedState(
            env: ["OPENCLAW_CONFIG_PATH": configPath],
            defaults: [remoteTargetKey: "alice@gateway.example"])
        {
            OpenClawConfigFile.saveDict([
                "gateway": [
                    "mode": "remote",
                    "remote": [
                        "url": "ws://127.0.0.1:19999",
                    ],
                ],
            ])

            let state = AppState(preview: true)
            #expect(state.remoteTarget == "alice@gateway.example")
        }
    }

    @Test
    func `app state init preserves legacy SSH tunnel config until transport is explicit`() async {
        let configPath = TestIsolation.tempConfigPath()
        await TestIsolation.withIsolatedState(
            env: ["OPENCLAW_CONFIG_PATH": configPath],
            defaults: [remoteTargetKey: nil])
        {
            OpenClawConfigFile.saveDict([
                "gateway": [
                    "mode": "remote",
                    "remote": [
                        "url": "ws://127.0.0.1:18789",
                        "sshTarget": "steipete@192.168.0.202",
                    ],
                ],
            ])

            let state = AppState(preview: true)
            #expect(state.remoteTransport == .ssh)
            #expect(state.remoteUrl == "ws://127.0.0.1:18789")
        }
    }

    @Test
    func `synced gateway root preserves object token across mode and transport changes when untouched`() {
        let initialRoot: [String: Any] = [
            "gateway": [
                "mode": "remote",
                "remote": [
                    "transport": "direct",
                    "url": "wss://old-gateway.example",
                    "token": [
                        "$secretRef": "gateway-token", // pragma: allowlist secret
                    ],
                ],
            ],
        ]

        let sshRoot = AppState._testSyncedGatewayRoot(
            currentRoot: initialRoot,
            draft: .init(
                connectionMode: .remote,
                remoteTransport: .ssh,
                remoteTarget: "alice@gateway.example",
                remoteIdentity: "",
                remoteUrl: "",
                remoteToken: "",
                dirtyFields: [
                    .remoteTransport,
                    .remoteUrl,
                    .remoteTarget,
                    .remoteIdentity,
                    .remoteHostKeyPolicy,
                ]))
        let sshRemote = (sshRoot["gateway"] as? [String: Any])?["remote"] as? [String: Any]
        #expect((sshRemote?["token"] as? [String: String])?["$secretRef"] ==
            "gateway-token") // pragma: allowlist secret

        let localRoot = AppState._testSyncedGatewayRoot(
            currentRoot: sshRoot,
            draft: .init(
                connectionMode: .local,
                remoteTransport: .ssh,
                remoteTarget: "",
                remoteIdentity: "",
                remoteUrl: "",
                remoteToken: "",
                dirtyFields: [.mode]))
        let localGateway = localRoot["gateway"] as? [String: Any]
        let localRemote = localGateway?["remote"] as? [String: Any]
        #expect(localGateway?["mode"] as? String == "local")
        #expect((localRemote?["token"] as? [String: String])?["$secretRef"] ==
            "gateway-token") // pragma: allowlist secret
    }

    @Test
    func `updated remote gateway config replaces object token when user enters plaintext`() {
        let remote = AppState._testUpdatedRemoteGatewayConfig(
            current: [
                "token": [
                    "$secretRef": "gateway-token", // pragma: allowlist secret
                ],
            ],
            draft: .init(
                transport: .direct,
                remoteUrl: "wss://gateway.example",
                remoteHost: nil,
                remoteTarget: "",
                remoteIdentity: "",
                remoteToken: "  fresh-token  ",
                dirtyFields: [.remoteToken]))

        #expect(remote["token"] as? String == "fresh-token")
    }

    @Test
    func `updated remote gateway config clears object token only after explicit edit`() {
        let current: [String: Any] = [
            "token": [
                "$secretRef": "gateway-token", // pragma: allowlist secret
            ],
        ]

        let preserved = AppState._testUpdatedRemoteGatewayConfig(
            current: current,
            draft: .init(
                transport: .direct,
                remoteUrl: "wss://gateway.example",
                remoteHost: nil,
                remoteTarget: "",
                remoteIdentity: "",
                remoteToken: "",
                dirtyFields: []))
        #expect((preserved["token"] as? [String: String])?["$secretRef"] == "gateway-token") // pragma: allowlist secret

        let cleared = AppState._testUpdatedRemoteGatewayConfig(
            current: current,
            draft: .init(
                transport: .direct,
                remoteUrl: "wss://gateway.example",
                remoteHost: nil,
                remoteTarget: "",
                remoteIdentity: "",
                remoteToken: "   ",
                dirtyFields: [.remoteToken]))
        #expect((cleared["token"] as? String) == nil)
    }

    @Test
    func `synced gateway root preserves gateway auth across mode changes`() {
        let initialRoot: [String: Any] = [
            "gateway": [
                "mode": "remote",
                "auth": [
                    "mode": "token",
                    "token": "test-token", // pragma: allowlist secret
                ],
                "remote": [
                    "transport": "direct",
                    "url": "wss://old-gateway.example",
                ],
            ],
        ]

        let localRoot = AppState._testSyncedGatewayRoot(
            currentRoot: initialRoot,
            draft: .init(
                connectionMode: .local,
                remoteTransport: .ssh,
                remoteTarget: "",
                remoteIdentity: "",
                remoteUrl: "",
                remoteToken: "",
                dirtyFields: [.mode]))
        let localGateway = localRoot["gateway"] as? [String: Any]
        let auth = localGateway?["auth"] as? [String: Any]
        #expect(localGateway?["mode"] as? String == "local")
        #expect(auth?["mode"] as? String == "token")
        #expect(auth?["token"] as? String == "test-token") // pragma: allowlist secret
    }
}
