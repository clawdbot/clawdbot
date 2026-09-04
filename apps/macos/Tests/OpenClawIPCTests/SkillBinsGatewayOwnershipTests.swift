import ConcurrencyExtras
import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

@MainActor
struct SkillBinsGatewayOwnershipTests {
    @Test(
        .execApprovalsStateIsolated,
        arguments: ["unchanged", "disconnected", "replacement"], ["skill", "fallback", "explicit", "manual", "full"])
    func `implicit skill trust follows the gateway that supplied it`(
        transition: String, authorizationKind: String) async throws
    {
        let replaceGateway = transition == "replacement"
        let requiresSkillTrust = authorizationKind == "skill" || authorizationKind == "fallback"
        let root = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: root) }
        let marker = root.appendingPathComponent("executed")
        let selectedURL = try LockIsolated(#require(URL(string: "ws://127.0.0.1:49345/")))
        let statusReads = LockIsolated<[URL]>([])
        let session = GatewayTestWebSocketSession(taskFactory: {
            let url = selectedURL.value
            return GatewayTestWebSocketTask(sendHook: { socket, message, sendIndex in
                guard sendIndex > 0 else { return }
                let data: Data = switch message {
                case let .data(data): data
                case let .string(text): Data(text.utf8)
                @unknown default: throw URLError(.cannotParseResponse)
                }
                let frame = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
                let id = try #require(frame["id"] as? String)
                let payload: String
                if frame["method"] as? String == "skills.status" {
                    statusReads.withValue { $0.append(url) }
                    let report = Self.report(bins: url.port == 49345 ? ["touch"] : [])
                    payload = try #require(String(data: JSONEncoder().encode(report), encoding: .utf8))
                } else {
                    payload = #"{"ok":true}"#
                }
                socket.emitReceiveSuccess(.data(Data(
                    #"{"type":"res","id":"\#(id)","ok":true,"payload":\#(payload)}"#.utf8)))
            })
        })
        let gateway = GatewayConnection(
            configProvider: { (selectedURL.value, nil, nil) },
            sessionBox: WebSocketSessionBox(session: session))
        let cache = SkillBinsCache(gateway: gateway)
        do {
            let command = ["touch", marker.path]
            let resolutions = ExecCommandResolution.resolveForAllowlist(
                command: command, rawCommand: nil, cwd: root.path, env: nil)
            try #require(ExecCommandResolution.bindForAllowlistExecution(
                command: command, rawCommand: nil, resolutions: resolutions) != nil)
            let first = await cache.current()?.trustByName ?? [:]
            try #require(ExecApprovalEvaluator.isSkillAutoAllowed(resolutions, trustedBinsByName: first))
            #expect(statusReads.value.count == 1)
            let settings = ExecApprovalsSettingsModel(skillBinsCache: cache)
            settings.autoAllowSkills = true
            await settings.refreshSkillBins()
            try #require(settings.skillBins == ["touch"])
            let resolvedPath = try #require(resolutions.first?.resolvedRealPath ?? resolutions.first?.resolvedPath)
            _ = try ExecApprovalsStore.updateAgentSettings(agentId: "skill-trust-proof") { entry in
                entry.security = authorizationKind == "full" ? .full : .allowlist
                entry.ask = .off
                entry.askFallback = authorizationKind == "fallback" ? .allowlist : .deny
                entry.autoAllowSkills = true
                entry.allowlist = authorizationKind == "manual" ? [ExecAllowlistEntry(pattern: resolvedPath)] : []
            }.get()
            let evaluation = await ExecApprovalEvaluator.evaluate(
                command: command,
                rawCommand: nil,
                cwd: root.path,
                envOverrides: nil,
                agentId: "skill-trust-proof",
                skillBinsCache: cache)
            try #require(evaluation.skillAllow)
            let commit = {
                ExecApprovalExecutionCommit.build(
                    context: evaluation,
                    effectiveSecurity: evaluation.security,
                    approvalSource: authorizationKind == "fallback" ? .askFallback : nil,
                    explicitlyApproved: authorizationKind == "explicit",
                    persistAllowlist: false)
            }
            let capturedCommit = commit()
            _ = try ExecApprovalsStore.commitExecution(capturedCommit).get()

            if replaceGateway {
                selectedURL.withValue { $0 = URL(string: "ws://127.0.0.1:49346/")! }
                _ = try await gateway.acquireServerLease()
            } else if transition == "disconnected" {
                let trust = try #require(evaluation.skillTrust)
                await gateway._test_handleDisconnect(socketGeneration: trust.source.socketGeneration)
                try #require(trust.isCurrent)
            }
            let execution = try await ExecHostExecutor.runApprovedCommand(
                authorization: capturedCommit.authorization,
                command: #require(evaluation.boundCommand),
                cwd: #require(ExecCommandResolution.captureApprovalCwdSnapshot(root.path)),
                env: evaluation.env,
                timeout: 2)
            let executionAllowed = !replaceGateway || !requiresSkillTrust
            #expect(execution.success == executionAllowed)
            #expect(FileManager.default.fileExists(atPath: marker.path) == executionAllowed)
            if !executionAllowed {
                #expect(execution.preflightError != nil)
            }
            #expect(settings.skillBins == (replaceGateway ? [] : ["touch"]))
            #expect(evaluation.skillAllow == !replaceGateway)
            let committed = switch ExecApprovalsStore.commitExecution(commit()) {
            case .success: true
            case .failure: false
            }
            #expect(committed == executionAllowed)
            let capturedCommitAccepted = switch ExecApprovalsStore.commitExecution(capturedCommit) {
            case .success: true
            case .failure: false
            }
            #expect(capturedCommitAccepted == executionAllowed)
            let current = await cache.current()?.trustByName ?? [:]
            #expect(ExecApprovalEvaluator
                .isSkillAutoAllowed(resolutions, trustedBinsByName: current) == !replaceGateway)
            #expect(statusReads.value.count == (replaceGateway ? 2 : 1))
            if replaceGateway {
                let refreshed = await cache.current(force: true)?.trustByName ?? [:]
                #expect(!ExecApprovalEvaluator.isSkillAutoAllowed(resolutions, trustedBinsByName: refreshed))
            } else if authorizationKind == "skill" {
                _ = try ExecApprovalsStore.updateAgentSettings(agentId: "skill-trust-proof") { entry in
                    entry.autoAllowSkills = nil
                }.get()
                try #require(evaluation.skillAllow)
                let revoked = switch ExecApprovalsStore.commitExecution(capturedCommit) {
                case .failure(.unavailable): true
                case .success, .failure: false
                }
                #expect(revoked)
            }
        } catch {
            await gateway.shutdown()
            throw error
        }
        await gateway.shutdown()
    }

    private nonisolated static func report(bins: [String]) -> SkillsStatusReport {
        SkillsStatusReport(
            workspaceDir: "/tmp/skill-trust-fixture",
            managedSkillsDir: "/tmp/skill-trust-fixture",
            skills: [
                SkillStatus(
                    name: "Synthetic no-op",
                    description: "Gateway-owned implicit skill trust",
                    source: "fixture",
                    filePath: "/tmp/skill-trust-fixture/SKILL.md",
                    baseDir: "/tmp/skill-trust-fixture",
                    skillKey: "gateway-trust-source-fixture",
                    primaryEnv: nil,
                    emoji: nil,
                    homepage: nil,
                    always: false,
                    disabled: false,
                    eligible: true,
                    requirements: SkillRequirements(bins: bins, env: [], config: []),
                    missing: SkillMissing(bins: [], env: [], config: []),
                    configChecks: [],
                    install: []),
            ])
    }
}

extension SkillBinsGatewayOwnershipTests {
    @Test(arguments: ["unchanged", "disconnected", "replacement", "cancelled"])
    func `refresh publication preserves only current uncancelled prior trust`(transition: String) async throws {
        let selectedURL = try LockIsolated(#require(URL(string: "ws://127.0.0.1:49347/")))
        let statusReads = LockIsolated(0)
        let pending = LockIsolated<(GatewayTestWebSocketTask, String)?>(nil)
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { socket, message, sendIndex in
                guard sendIndex > 0 else { return }
                let data: Data = switch message {
                case let .data(data): data
                case let .string(text): Data(text.utf8)
                @unknown default: throw URLError(.cannotParseResponse)
                }
                let frame = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
                let id = try #require(frame["id"] as? String)
                if frame["method"] as? String == "health" {
                    socket.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
                    return
                }
                try #require(frame["method"] as? String == "skills.status")
                let read = statusReads.withValue { count in count += 1
                    return count
                }
                if read == 1 {
                    let payload = try JSONEncoder().encode(Self.report(bins: ["true"]))
                    let report = try #require(String(data: payload, encoding: .utf8))
                    socket.emitReceiveSuccess(.data(Data(
                        #"{"type":"res","id":"\#(id)","ok":true,"payload":\#(report)}"#.utf8)))
                } else {
                    pending.withValue { $0 = (socket, id) }
                }
            })
        })
        let gateway = GatewayConnection(
            configProvider: { (selectedURL.value, nil, nil) },
            sessionBox: WebSocketSessionBox(session: session))
        let cache = SkillBinsCache(gateway: gateway)
        let executor = SkillCachePublicationExecutor()
        let entered = LockIsolated(false)
        let release = DispatchSemaphore(value: 0)
        var blocked: Task<Bool, Never>?
        var refresh: Task<SkillBinsCache.Snapshot?, Never>?
        do {
            let first = try #require(await cache.current())
            try #require(first.bins == ["true"])
            refresh = Task.detached(executorPreference: executor) { await cache.current(force: true) }
            try await Self.waitForRetentionStage { pending.value != nil && executor.isIdle }
            blocked = Task.detached(executorPreference: SkillCachePublicationExecutor()) {
                await holdSkillCacheActor(cache, entered: entered, release: release)
            }
            try await Self.waitForRetentionStage { entered.value }
            executor.pause()
            let (socket, id) = try #require(pending.value)
            let receiveCount = socket.snapshotCallbackReceiveCount()
            let payload = try JSONEncoder().encode(Self.report(bins: ["printf"]))
            let report = try #require(String(data: payload, encoding: .utf8))
            socket.emitReceiveSuccess(.data(Data(
                #"{"type":"res","id":"\#(id)","ok":true,"payload":\#(report)}"#.utf8)))
            try await Self.waitForRetentionStage {
                executor.hasQueuedJobs && socket.snapshotCallbackReceiveCount() > receiveCount
            }
            // Finish the validated response while the receiving cache actor is occupied.
            executor.runQueuedJobs()
            _ = await gateway.lastSnapshot
            executor.runQueuedJobs()
            switch transition {
            case "disconnected":
                await gateway._test_handleDisconnect(socketGeneration: first.source.socketGeneration)
                try #require(gateway.serverLeaseMatchesCurrentRoute(first.source))
                try #require(!gateway.serverLeaseMatchesCurrentState(first.source))
            case "replacement":
                selectedURL.withValue { $0 = URL(string: "ws://127.0.0.1:49348/")! }
                _ = try await gateway.acquireServerLease()
                try #require(!first.isCurrent)
            case "cancelled":
                refresh?.cancel()
            default:
                break
            }
            release.signal()
            try #require(await blocked?.value == true)
            executor.resume()
            let result = await refresh?.value
            switch transition {
            case "unchanged": #expect(result?.bins == ["printf"])
            case "disconnected": #expect(result?.bins == ["true"])
            default: #expect(result == nil)
            }
        } catch {
            release.signal()
            executor.resume()
            refresh?.cancel()
            _ = await refresh?.value
            _ = await blocked?.value
            await gateway.shutdown()
            throw error
        }
        await gateway.shutdown()
    }

    private static func waitForRetentionStage(_ predicate: () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(2)
        while !predicate(), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(1))
        }
        try #require(predicate())
    }
}

private func holdSkillCacheActor(
    _ cache: isolated SkillBinsCache,
    entered: LockIsolated<Bool>,
    release: DispatchSemaphore) -> Bool
{
    cache.assertIsolated()
    entered.withValue { $0 = true }
    return release.wait(timeout: .now() + 5) == .success
}

private final class SkillCachePublicationExecutor: TaskExecutor {
    private struct State {
        var paused = false
        var outstanding = 0
        var jobs: [UnownedJob] = []
    }

    private let state = LockIsolated(State())
    private let queue = DispatchQueue(label: "skill-cache-publication-test")

    var hasQueuedJobs: Bool {
        self.state.value.jobs.isEmpty == false
    }

    var isIdle: Bool {
        self.state.value.outstanding == 0
    }

    func enqueue(_ job: consuming ExecutorJob) {
        let job = UnownedJob(job)
        let queued = self.state.withValue { state in
            if state.paused {
                state.jobs.append(job)
                return true
            }
            state.outstanding += 1
            return false
        }
        if !queued { self.queue.async { self.run(job) } }
    }

    func pause() {
        self.state.withValue { $0.paused = true }
    }

    func runQueuedJobs() {
        while let job = self.state.withValue({ state -> UnownedJob? in
            guard !state.jobs.isEmpty else { return nil }
            state.outstanding += 1
            return state.jobs.removeFirst()
        }) {
            self.queue.sync { self.run(job) }
        }
    }

    func resume() {
        let jobs = self.state.withValue { state in
            state.paused = false
            state.outstanding += state.jobs.count
            defer { state.jobs.removeAll() }
            return state.jobs
        }
        for job in jobs {
            self.queue.async { self.run(job) }
        }
    }

    private func run(_ job: UnownedJob) {
        defer { self.state.withValue { $0.outstanding -= 1 } }
        job.runSynchronously(on: self.asUnownedTaskExecutor())
    }
}

extension SkillBinsGatewayOwnershipTests {
    @Test(.execApprovalsStateIsolated, arguments: ["replacement", "unavailable-recovery", "same-route"])
    func `mounted trust list follows the selected gateway without another UI action`(
        transition: String) async throws
    {
        let configPath = TestIsolation.tempConfigPath()
        try Data("{}".utf8).write(to: URL(fileURLWithPath: configPath))
        defer { try? FileManager().removeItem(atPath: configPath) }
        try await TestIsolation.withEnvValues(["OPENCLAW_CONFIG_PATH": configPath]) {
            let selection = LockIsolated((revision: UInt64(1), available: true))
            let statusReads = LockIsolated<[UInt64]>([])
            let session = GatewayTestWebSocketSession(taskFactory: {
                let revision = selection.value.revision
                return GatewayTestWebSocketTask(sendHook: { socket, message, sendIndex in
                    guard sendIndex > 0 else { return }
                    let data: Data = switch message {
                    case let .data(data): data
                    case let .string(text): Data(text.utf8)
                    @unknown default: throw URLError(.cannotParseResponse)
                    }
                    let frame = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
                    let id = try #require(frame["id"] as? String)
                    if frame["method"] as? String == "health" {
                        socket.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
                        return
                    }
                    if frame["method"] as? String == "config.get" {
                        let agent = revision == 1 ? "alice" : "bob"
                        let config = #"""
                        {"hash":"fixture-\#(revision)","valid":true,
                         "config":{"agents":{"list":[{"id":"\#(agent)","default":true}]}}}
                        """#
                        socket.emitReceiveSuccess(.data(Data(
                            #"{"type":"res","id":"\#(id)","ok":true,"payload":\#(config)}"#.utf8)))
                        return
                    }
                    try #require(frame["method"] as? String == "skills.status")
                    statusReads.withValue { $0.append(revision) }
                    let payload = try JSONEncoder().encode(Self.report(bins: revision == 1 ? ["true"] : ["printf"]))
                    let report = try #require(String(data: payload, encoding: .utf8))
                    socket.emitReceiveSuccess(.data(Data(
                        #"{"type":"res","id":"\#(id)","ok":true,"payload":\#(report)}"#.utf8)))
                })
            })
            let gateway = GatewayConnection(
                testEndpointProvider: {
                    let selected = selection.value
                    guard selected.available else { throw URLError(.notConnectedToInternet) }
                    let url = try #require(URL(string: "ws://127.0.0.1:\(49348 + selected.revision)/"))
                    return GatewayConnection.EndpointSnapshot(
                        config: (url, nil, nil),
                        routeAuthority: selected.revision,
                        revision: selected.revision)
                },
                currentEndpointRevision: { selection.value.revision },
                sessionBox: WebSocketSessionBox(session: session))
            let cache = SkillBinsCache(gateway: gateway)
            _ = try ExecApprovalsStore.updateAgentSettings(agentId: "alice") { entry in
                entry.security = .allowlist
                entry.ask = .off
                entry.autoAllowSkills = true
                entry.allowlist = [ExecAllowlistEntry(id: "local-rule", pattern: "/usr/bin/false")]
            }.get()
            let model = ExecApprovalsSettingsModel(skillBinsCache: cache)
            let lifetime = Task { await model.run() }
            do {
                try await Self.waitForRetentionStage { model.policyAvailable && model.skillBins == ["true"] }
                try #require(model.agentIds == ["alice"])
                try #require(model.selectedAgentId == "alice")
                let first = try await gateway.acquireServerLease()
                if transition == "same-route" {
                    let socket = try #require(session.latestTask())
                    socket.emitReceiveFailure(URLError(.networkConnectionLost))
                    try await Self.waitForRetentionStage { !gateway.serverLeaseMatchesCurrentState(first) }
                    try #require(model.skillBins == ["true"])
                    _ = try await gateway.acquireServerLease()
                    try #require(gateway.serverLeaseMatchesCurrentRoute(first))
                } else {
                    selection.withValue { $0 = (revision: 2, available: transition != "unavailable-recovery") }
                    if transition == "unavailable-recovery" {
                        try await gateway.adoptSelectedEndpoint()
                        try #require(model.skillBins.isEmpty)
                        do {
                            try await gateway.refresh()
                            Issue.record("Unavailable replacement unexpectedly prepared an endpoint")
                        } catch {
                            #expect((error as? URLError)?.code == .notConnectedToInternet)
                        }
                        selection.withValue { $0.available = true }
                    }
                    _ = try await gateway.acquireServerLease()
                }
                let expected = transition == "same-route" ? ["true"] : ["printf"]
                let expectedAgents = transition == "same-route" ? ["alice"] : ["bob"]
                let deadline = ContinuousClock.now + .seconds(2)
                while model.skillBins != expected || model.agentIds != expectedAgents,
                      ContinuousClock.now < deadline
                {
                    try await Task.sleep(for: .milliseconds(1))
                }
                #expect(model.skillBins == expected)
                #expect(model.agentIds == expectedAgents)
                #expect(model.defaultAgentId == expectedAgents[0])
                #expect(model.agentPickerIds.contains("alice"))
                #expect(expectedAgents.allSatisfy { model.agentPickerIds.contains($0) })
                #expect(statusReads.value == (transition == "same-route" ? [1] : [1, 2]))
                #expect(model.autoAllowSkills)
                #expect(model.selectedAgentId == "alice")
                #expect(model.security == .allowlist)
                #expect(model.ask == .off)
                #expect(model.entries.map(\.id) == ["local-rule"])
            } catch {
                lifetime.cancel()
                await lifetime.value
                await gateway.shutdown()
                throw error
            }
            lifetime.cancel()
            await lifetime.value
            await gateway.shutdown()
        }
    }
}
