import ConcurrencyExtras
import Foundation
import Testing
@testable import OpenClaw
@testable import OpenClawKit

final class CronSourceFixture: @unchecked Sendable {
    struct Request: Sendable {
        let gateway: String
        let id: String
        let method: String
        let jobID: String?
        let socket: GatewayTestWebSocketTask
    }

    let endpoint = LockIsolated(CronSourceFixture.endpoint(revision: 1))
    let requests = LockIsolated<[Request]>([])
    let emptyJobLists = LockIsolated(false)
    let gateway: GatewayConnection

    init(
        holding method: String? = nil,
        preparedOwner: Bool = true,
        endpointStore: GatewayEndpointStore? = nil,
        beforeEndpointLookup: (@Sendable () async throws -> Void)? = nil)
    {
        if !preparedOwner { self.endpoint.setValue(Self.endpoint(revision: 1, preparedOwner: false)) }
        let endpoint = self.endpoint
        let requests = self.requests
        let emptyJobLists = self.emptyJobLists
        let session = GatewayTestWebSocketSession(taskFactory: {
            let owner = endpoint.value.revision == 1 ? "A" : "B"
            return GatewayTestWebSocketTask(sendHook: { socket, message, sendIndex in
                guard sendIndex > 0,
                      let data = Self.data(message),
                      let frame = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let id = frame["id"] as? String,
                      let requestMethod = frame["method"] as? String
                else { return }
                let params = frame["params"] as? [String: Any]
                let request = Request(
                    gateway: owner,
                    id: id,
                    method: requestMethod,
                    jobID: params?["id"] as? String,
                    socket: socket)
                requests.withValue { $0.append(request) }
                if requestMethod != method { Self.respond(request, emptyJobList: emptyJobLists.value) }
            })
        })
        self.gateway = GatewayConnection(
            testEndpointProvider: {
                try await beforeEndpointLookup?()
                if let endpointStore { return try await endpointStore.requireEndpoint() }
                return endpoint.value
            },
            currentEndpointRevision: { endpointStore?.routeRevision ?? endpoint.value.revision! },
            sessionBox: WebSocketSessionBox(session: session))
    }

    func adoptB() {
        self.endpoint.setValue(Self.endpoint(revision: 2))
    }

    static func configuration(revision: UInt64) -> [String: Any] {
        ["gateway": ["mode": "remote", "remote": ["transport": "direct", "url": "ws://127.0.0.1:\(49300 + revision)"]]]
    }

    private static func endpoint(revision: UInt64, preparedOwner: Bool = true) -> GatewayConnection.EndpointSnapshot {
        GatewayConnection.EndpointSnapshot(
            config: (URL(string: "ws://127.0.0.1:\(49300 + revision)")!, nil, nil),
            routeAuthority: nil,
            deviceAuthGatewayID: preparedOwner
                ? GatewayDiscoveryPreferences.deviceAuthGatewayID(root: self.configuration(revision: revision)) : nil,
            revision: revision)
    }

    private static func data(_ message: URLSessionWebSocketTask.Message) -> Data? {
        switch message {
        case let .data(data): data
        case let .string(text): text.data(using: .utf8)
        @unknown default: nil
        }
    }

    static func fail(_ request: Request, message: String) {
        let response = #"{"type":"res","id":"\#(request.id)","ok":false,"# +
            #""error":{"code":"INVALID_REQUEST","message":"\#(message)"}}"#
        request.socket.emitReceiveSuccess(.data(Data(response.utf8)))
    }

    static func respond(_ request: Request, emptyJobList: Bool = false) {
        let payload = switch request.method {
        case "cron.status":
            #"{"enabled":true,"storePath":"/gateway-\#(request.gateway)","jobs":1}"#
        case "cron.list":
            emptyJobList ? #"{"jobs":[]}"# : #"""
            {"jobs":[{"id":"shared-job","name":"Gateway \#(request.gateway)","enabled":true,
            "createdAtMs":0,"updatedAtMs":0,"schedule":{"kind":"every","everyMs":1000},
            "sessionTarget":"isolated","wakeMode":"now","payload":{"kind":"systemEvent","text":"fixture"},"state":{}}]}
            """#
        case "cron.runs":
            #"""
            {"entries":[{"ts":1,"jobId":"shared-job","action":"finished","status":"ok",
            "summary":"Gateway \#(request.gateway)"}]}
            """#
        default:
            #"{"ok":true}"#
        }
        request.socket.emitReceiveSuccess(.data(Data(
            #"{"type":"res","id":"\#(request.id)","ok":true,"payload":\#(payload)}"#.utf8)))
    }
}

@Suite(.serialized)
@MainActor
struct CronGatewayOwnershipTests {
    @Test(arguments: ["run", "delete", "enable", "edit", "add"], [false, true])
    func `settings actions retain the Gateway that supplied their row or editor`(
        action: String,
        replacePrimary: Bool) async throws
    {
        let fixture = CronSourceFixture()
        let store = CronJobsStore(gateway: fixture.gateway, endpointRevision: { fixture.endpoint.value.revision! })
        await store.refreshJobs()
        let retainedJob = try #require(store.snapshot?.rows.first)
        let newEditor = store.newEditor()
        #expect(retainedJob.job.name == "Gateway A")
        let previousCount = fixture.requests.value.count
        if replacePrimary {
            fixture.adoptB()
            try await fixture.gateway.refresh()
        } else if action == "add" {
            // An ID-free draft may acquire fresh authority after an explicit restart
            // of the same Primary; changing Primary still rejects that draft.
            await fixture.gateway.shutdown()
        }

        do {
            switch action {
            case "run": await store.runJob(retainedJob)
            case "delete": await store.removeJob(retainedJob)
            case "enable": await store.setJobEnabled(retainedJob, enabled: false)
            case "edit": try await store.upsertJob(retainedJob.editor, payload: ["name": AnyCodable("edited")])
            case "add":
                try await store.upsertJob(newEditor, payload: [
                    "name": AnyCodable("new"),
                    "schedule": AnyCodable(["kind": "every", "everyMs": 60000] as [String: Any]),
                    "sessionTarget": AnyCodable("isolated"),
                    "wakeMode": AnyCodable("now"),
                    "payload": AnyCodable(["kind": "agentTurn", "message": "fixture"]),
                ])
            default: Issue.record("unexpected action")
            }
        } catch {
            if !replacePrimary { throw error }
        }

        let mutations = fixture.requests.value.dropFirst(previousCount).filter {
            ["cron.run", "cron.remove", "cron.update", "cron.add"].contains($0.method)
        }
        #expect(mutations.map(\.gateway) == (replacePrimary ? [] : ["A"]))
        store.stop(.settings)
        await fixture.gateway.shutdown()
    }

    @Test(arguments: ["active replacement", "inactive replacement", "inactive same route"])
    func `unavailable selections keep Cron data scoped across active and stopped consumers`(
        scenario: String) async throws
    {
        try await TestIsolation.withIsolatedState {
            AppStateStore.shared.connectionMode = .unconfigured
            let unavailable = LockIsolated(false)
            let fixture = CronSourceFixture(beforeEndpointLookup: {
                if unavailable.value { throw URLError(.cannotConnectToHost) }
            })
            let store = CronJobsStore(gateway: fixture.gateway, endpointRevision: { fixture.endpoint.value.revision! })
            var control: ControlChannel? = ControlChannel(
                gateway: fixture.gateway, endpointRevision: { fixture.endpoint.value.revision! })
            @MainActor func cleanup() async {
                control = nil
                store.stop(.settings)
                store.stop(.statusMenu)
                await fixture.gateway.shutdown()
            }
            do {
                let inactive = scenario.hasPrefix("inactive")
                let replacePrimary = scenario != "inactive same route"
                store.start(.settings)
                if inactive { store.start(.statusMenu) }
                try await self
                    .waitUntil { store.jobs.count == 1 && !store.isLoadingJobs && control?.state == .connected }
                let original = try #require(store.snapshot?.rows.first)
                store.selectJob(original)
                try await self.waitUntil { !store.isLoadingRuns && store.runEntries.count == 1 }
                #expect(store.jobs.first?.name == "Gateway A")
                #expect(store.runEntries.first?.summary == "Gateway A")
                let requestCount = fixture.requests.value.count

                if inactive {
                    store.stop(.settings)
                    store.stop(.statusMenu)
                    #expect(store.jobs.first?.name == "Gateway A")
                }
                unavailable.setValue(true)
                if replacePrimary { fixture.adoptB() }
                control?.endpointDidChange(.unavailable(
                    mode: .remote,
                    reason: "Synthetic Gateway unavailable",
                    routeRevision: fixture.endpoint.value.revision!))
                if inactive {
                    // The connection retires while neither pane is subscribed. Reopening
                    // must not display a foreign cache before its failed acquisition ends.
                    try await fixture.gateway.adoptSelectedEndpoint()
                    store.start(.settings)
                    #expect(store.jobs.isEmpty == replacePrimary)
                    try await self.waitUntil { store.lastError != nil && !store.isLoadingJobs }
                } else {
                    #expect(store.snapshot == nil)
                    #expect(store.selectedJob == nil)
                    // Exposure is revoked synchronously; the subscribed consumer
                    // clears retained history when its retirement receipt arrives.
                    try await self.waitUntil { store.runEntries.isEmpty }
                }

                #expect((store.snapshot == nil) == replacePrimary)
                #expect(store.jobs.isEmpty == replacePrimary)
                #expect((store.selectedJob == nil) == replacePrimary)
                #expect((store.schedulerStorePath == nil) == replacePrimary)
                if !inactive {
                    #expect(store.runEntries.isEmpty)
                    #expect(store.statusMessage?.contains("disconnected") == true)
                }
                #expect(fixture.requests.value.dropFirst(requestCount).allSatisfy { $0.gateway == "A" })
            } catch {
                await cleanup()
                throw error
            }
            await cleanup()
        }
    }

    @Test(arguments: ["run", "save"])
    func `retained durable job actions reconnect to the same configured Gateway`(action: String) async throws {
        let fixture = CronSourceFixture()
        let store = CronJobsStore(gateway: fixture.gateway, endpointRevision: { fixture.endpoint.value.revision! })
        await store.refreshJobs()
        let retainedJob = try #require(store.snapshot?.rows.first)
        let originalLease = try await fixture.gateway.acquireServerLease()
        let socket = try #require(fixture.requests.value.first?.socket)
        try await self.waitUntil { socket.hasPendingReceiveHandler() }
        socket.emitReceiveFailure()
        try await self.waitUntil { !fixture.gateway.serverLeaseMatchesCurrentState(originalLease) }
        let previousCount = fixture.requests.value.count

        // The job/editor survives a socket reconnect, as it does after Mac sleep.
        // Keep the selected endpoint and let the action use its normal reconnect path.
        var actionError: String?
        do {
            if action == "run" {
                await store.runJob(retainedJob)
            } else {
                try await store.upsertJob(retainedJob.editor, payload: ["name": AnyCodable("edited")])
            }
        } catch {
            actionError = error.localizedDescription
        }

        let replacementLease = try await fixture.gateway.acquireServerLease()
        #expect(replacementLease != originalLease)
        #expect(await fixture.gateway.isCurrentRoute(originalLease.route))
        let mutations = fixture.requests.value.dropFirst(previousCount).filter {
            ["cron.run", "cron.update"].contains($0.method)
        }
        #expect(mutations.map(\.gateway) == ["A"])
        #expect(mutations.map(\.jobID) == [retainedJob.job.id])
        #expect(actionError == nil)
        #expect(store.lastError == nil)
        store.stop(.settings)
        await fixture.gateway.shutdown()
    }

    @Test(arguments: ["cron.run", "cron.remove", "cron.update"])
    func `a retired mutation completion preserves the new Gateway error`(method: String) async throws {
        let (arrivals, entered) = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
        let (releases, release) = AsyncStream<Void>.makeStream()
        let heldLookup = Task { for await _ in releases {} }
        let holdNextLookup = LockIsolated(false)
        let fixture = CronSourceFixture(holding: method, beforeEndpointLookup: {
            guard holdNextLookup.withValue({ value in
                defer { value = false }
                return value
            }) else { return }
            entered.yield(())
            await heldLookup.value
        })
        let store = CronJobsStore(gateway: fixture.gateway, endpointRevision: { fixture.endpoint.value.revision! })
        await store.refreshJobs()
        let original = try #require(store.snapshot?.rows.first)
        func mutate(_ context: CronJobsStore.JobContext) async {
            switch method {
            case "cron.run": await store.runJob(context)
            case "cron.remove": await store.removeJob(context)
            default: await store.setJobEnabled(context, enabled: false)
            }
        }
        let older = Task { await mutate(original) }
        var newer: Task<Void, Never>?
        func cleanup() async {
            release.finish()
            entered.finish()
            store.stop(.settings)
            await fixture.gateway.shutdown()
            await older.value
            await newer?.value
            await heldLookup.value
        }
        do {
            try await self.waitUntil { fixture.requests.value.contains { $0.method == method } }
            let pending = try #require(fixture.requests.value.first { $0.method == method })
            // Hold A's post-reply validation, leaving the new source free to finish its own action.
            holdNextLookup.setValue(true)
            CronSourceFixture.respond(pending)
            let arrived = try await AsyncTimeout.withTimeout(
                seconds: 2,
                onTimeout: { URLError(.timedOut) },
                operation: {
                    for await _ in arrivals {
                        return true
                    }
                    return false
                })
            try #require(arrived)
            fixture.adoptB()
            await store.refreshJobs()
            let replacement = try #require(store.snapshot?.rows.first)
            #expect(replacement.job.name == "Gateway B")
            newer = Task { await mutate(replacement) }
            try await self.waitUntil {
                fixture.requests.value.contains { $0.method == method && $0.gateway == "B" }
            }
            let current = try #require(fixture.requests.value.first { $0.method == method && $0.gateway == "B" })
            CronSourceFixture.fail(current, message: "Gateway B operation failed")
            await newer?.value
            let currentError = try #require(store.lastError)
            #expect(currentError.contains("Gateway B operation failed"))
            release.finish()
            await older.value

            #expect(store.lastError == currentError)
            #expect(store.jobs.first?.name == "Gateway B")
        } catch {
            await cleanup()
            throw error
        }
        await cleanup()
    }

    @Test(arguments: ["run", "delete", "enable"])
    func `dispatch discovery rejects an external Gateway change in the displayed pane`(action: String) async throws {
        let configPath = TestIsolation.tempConfigPath()
        defer { try? FileManager.default.removeItem(atPath: configPath) }
        try await TestIsolation.withIsolatedState(env: ["OPENCLAW_CONFIG_PATH": configPath]) {
            try JSONSerialization.data(withJSONObject: CronSourceFixture.configuration(revision: 1))
                .write(to: URL(fileURLWithPath: configPath))
            let endpointStore = self.configBackedEndpointStore()
            let fixture = CronSourceFixture(endpointStore: endpointStore)
            let store = CronJobsStore(gateway: fixture.gateway, endpointRevision: { endpointStore.routeRevision })
            do {
                await store.refreshJobs()
                let retained = try #require(store.snapshot?.rows.first)
                let lease = try #require(await fixture.gateway.captureServerLease())
                #expect(retained.source == .gateway(lease))
                try JSONSerialization.data(withJSONObject: CronSourceFixture.configuration(revision: 2))
                    .write(to: URL(fileURLWithPath: configPath))
                #expect(fixture.gateway.serverLeaseMatchesCurrentRoute(lease))
                let previousCount = fixture.requests.value.count

                switch action {
                case "run": await store.runJob(retained)
                case "delete": await store.removeJob(retained)
                default: await store.setJobEnabled(retained, enabled: false)
                }

                let mutations = fixture.requests.value.dropFirst(previousCount).filter {
                    ["cron.run", "cron.remove", "cron.update"].contains($0.method)
                }
                #expect(mutations.isEmpty)
                #expect(store.jobs.isEmpty)
                #expect(store.lastError?.contains("The Gateway changed") == true)
            } catch {
                store.stop(.settings)
                await fixture.gateway.shutdown()
                throw error
            }
            store.stop(.settings)
            await fixture.gateway.shutdown()
        }
    }

    @Test(arguments: ["cron.list", "cron.runs"])
    func `source adoption rejects late Cron read publication before socket replacement`(
        method: String) async throws
    {
        let fixture = CronSourceFixture(holding: method)
        let store = CronJobsStore(gateway: fixture.gateway, endpointRevision: { fixture.endpoint.value.revision! })
        let refresh: Task<Void, Never>?
        if method == "cron.list" {
            refresh = Task { await store.refreshJobs() }
        } else {
            await store.refreshJobs()
            try store.selectJob(#require(store.snapshot?.rows.first))
            refresh = nil
        }
        try await self.waitUntil { fixture.requests.value.contains { $0.method == method } }
        let held = try #require(fixture.requests.value.first { $0.method == method })

        // The endpoint owner can adopt B before its connection work replaces A's socket.
        fixture.adoptB()
        CronSourceFixture.respond(held)
        await refresh?.value
        try await self.waitUntil { !store.isLoadingJobs && !store.isLoadingRuns }

        if method == "cron.list" {
            #expect(store.jobs.isEmpty)
            #expect(store.schedulerStorePath == nil)
        } else {
            #expect(store.runEntries.isEmpty)
        }
        store.stop(.settings)
        await fixture.gateway.shutdown()
    }

    @Test(arguments: [false, true])
    func `new offline drafts retain the Primary selected before acquisition starts`(
        switchDuringAcquire: Bool) async throws
    {
        let (arrivals, entered) = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
        let (releases, release) = AsyncStream<Void>.makeStream()
        let heldLookup = Task { for await _ in releases {} }
        let fixture = CronSourceFixture(beforeEndpointLookup: {
            entered.yield(())
            await heldLookup.value
        })
        let store = CronJobsStore(gateway: fixture.gateway, endpointRevision: { fixture.endpoint.value.revision! })
        let editor = store.newEditor()
        #expect(fixture.requests.value.isEmpty)
        let save = Task {
            do {
                try await store.upsertJob(editor, payload: [
                    "name": AnyCodable("new"),
                    "schedule": AnyCodable(["kind": "every", "everyMs": 60000] as [String: Any]),
                    "sessionTarget": AnyCodable("isolated"),
                    "wakeMode": AnyCodable("now"),
                    "payload": AnyCodable(["kind": "agentTurn", "message": "fixture"]),
                ])
                return nil as String?
            } catch {
                return error.localizedDescription
            }
        }
        func cleanup() async {
            release.finish()
            entered.finish()
            await heldLookup.value
            _ = await save.value
            store.stop(.settings)
            await fixture.gateway.shutdown()
        }
        do {
            let arrived = try await AsyncTimeout.withTimeout(
                seconds: 2,
                onTimeout: { URLError(.timedOut) },
                operation: {
                    for await _ in arrivals {
                        return true
                    }
                    return false
                })
            try #require(arrived)
            if switchDuringAcquire { fixture.adoptB() }
            release.finish()
            let error = await save.value
            let mutations = fixture.requests.value.filter { $0.method == "cron.add" }
            #expect(mutations.map(\.gateway) == (switchDuringAcquire ? [] : ["A"]))
            #expect((error != nil) == switchDuringAcquire)
        } catch {
            await cleanup()
            throw error
        }
        await cleanup()
    }

    @Test(.gatewayTLSStoreIsolated, arguments: [
        "current", "existing window", "socket disconnected", "socket reconnect", "retired route",
        "admitted replacement", "external config", "external credentials", "external TLS", "unknown owner",
    ])
    func `Transcript navigation validates the displayed source before creating its native window`(
        scenario: String) async throws
    {
        let configPath = TestIsolation.tempConfigPath()
        defer { try? FileManager.default.removeItem(atPath: configPath) }
        try await TestIsolation.withIsolatedState(env: ["OPENCLAW_CONFIG_PATH": configPath]) {
            var initialRoot = CronSourceFixture.configuration(revision: 1)
            if scenario == "external TLS" {
                initialRoot = ["gateway": ["mode": "remote", "remote": [
                    "transport": "direct", "url": "wss://127.0.0.1:49301",
                    "tlsFingerprint": String(repeating: "a", count: 64),
                ]]]
            }
            try JSONSerialization.data(withJSONObject: initialRoot).write(to: URL(fileURLWithPath: configPath))
            let endpointStore: GatewayEndpointStore? = if ["external credentials", "external TLS"].contains(scenario) {
                self.configBackedEndpointStore()
            } else {
                nil
            }
            let fixture = CronSourceFixture(preparedOwner: scenario != "unknown owner", endpointStore: endpointStore)
            try await withWebChatManagerLifetime(primaryConnection: fixture.gateway) { manager in
                let store = CronJobsStore(
                    gateway: fixture.gateway, endpointRevision: { fixture.endpoint.value.revision! })
                defer { store.stop(.settings) }
                await store.refreshJobs()
                let retained = try #require(store.snapshot?.rows.first)
                if scenario == "admitted replacement" || scenario == "external config" {
                    try JSONSerialization.data(withJSONObject: CronSourceFixture.configuration(revision: 2))
                        .write(to: URL(fileURLWithPath: configPath))
                }
                if scenario == "external credentials" || scenario == "external TLS" {
                    var root = initialRoot
                    var gateway = try #require(root["gateway"] as? [String: Any])
                    var remote = try #require(gateway["remote"] as? [String: Any])
                    if scenario == "external credentials" {
                        remote["token"] = "replacement-fixture-credential"
                    } else {
                        remote["tlsFingerprint"] = String(repeating: "b", count: 64)
                    }
                    gateway["remote"] = remote
                    root["gateway"] = gateway
                    try JSONSerialization.data(withJSONObject: root).write(to: URL(fileURLWithPath: configPath))
                }
                if scenario == "admitted replacement" {
                    fixture.adoptB()
                    try await fixture.gateway.refresh()
                }
                if ["external config", "external credentials", "external TLS"].contains(scenario),
                   case let .gateway(lease) = retained.source
                {
                    #expect(fixture.gateway.serverLeaseMatchesCurrentState(lease))
                }

                if scenario == "retired route" { await fixture.gateway.shutdown() }
                if scenario == "socket reconnect" || scenario == "socket disconnected" {
                    guard case let .gateway(lease) = retained.source else {
                        Issue.record("expected a displayed Gateway source")
                        return
                    }
                    let socket = try #require(fixture.requests.value.first?.socket)
                    socket.emitReceiveFailure()
                    try await self.waitUntil { !fixture.gateway.serverLeaseMatchesCurrentState(lease) }
                    if scenario == "socket reconnect" {
                        let reconnected = try await fixture.gateway.acquireServerLease()
                        #expect(reconnected != lease)
                    }
                    #expect(await fixture.gateway.isCurrentRoute(lease.route))
                }

                if scenario == "existing window" { manager.show(sessionKey: "existing-primary") }
                store.openTranscript(retained, using: manager)
                try await self.waitUntil { manager.activeSessionKey == "cron:shared-job" || store.lastError != nil }

                let sameGateway = ["current", "existing window", "socket disconnected", "socket reconnect"]
                    .contains(scenario)
                #expect(manager.activeSessionKey == (sameGateway ? "cron:shared-job" : nil))
                #expect((store.lastError == nil) == sameGateway)
                manager.resetPrimaryConnections()
                await fixture.gateway.shutdown()
            }
        }
    }

    private func configBackedEndpointStore() -> GatewayEndpointStore {
        let state = AppState(preview: true)
        return GatewayEndpointStore(deps: .init(
            token: { nil },
            password: { nil },
            localPort: { 49301 },
            localUnavailableReason: { nil },
            remoteRouteIfRunning: { nil },
            remoteRouteIsCurrent: { _ in true },
            canStartRemoteTunnel: { false },
            ensureRemoteTunnel: { throw CancellationError() },
            liveSourceIsCurrent: { _ in true },
            sourceSnapshot: {
                try await GatewayEndpointStore._testLiveSourceSnapshot(state: state, beforeConfigRead: {})
            }))
    }

    @Test(arguments: ["local", "direct", "ssh"])
    func `supported Primary routes retain distinct auth and existing cache identities`(transport: String) async {
        await TestIsolation.withIsolatedState {
            let root: [String: Any] = switch transport {
            case "local": ["gateway": ["mode": "local"]]
            case "direct": CronSourceFixture.configuration(revision: 1)
            default:
                [
                    "gateway": [
                        "mode": "remote",
                        "remote": ["transport": "ssh", "sshTarget": "user@gateway.test", "remotePort": 49311],
                    ],
                ]
            }
            #expect(GatewayDiscoveryPreferences.deviceAuthGatewayID(root: root) != nil)
            let expected = MacChatTranscriptCache.gatewayID(
                mode: transport == "local" ? .local : .remote,
                localStateDir: OpenClawConfigFile.stateDirURL(),
                remoteTransport: transport == "direct" ? .direct : .ssh,
                directURL: URL(string: "ws://127.0.0.1:49301"),
                sshTarget: "user@gateway.test",
                sshRemotePort: 49311)
            #expect(MacChatTranscriptCache.gatewayID(root: root) == expected)
        }
    }

    private func waitUntil(_ condition: () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(2)
        while !condition(), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(2))
        }
        try #require(condition())
    }
}
