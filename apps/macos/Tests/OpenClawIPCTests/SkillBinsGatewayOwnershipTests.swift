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
            let resolvedPath = try #require(resolutions.first?.resolvedRealPath ?? resolutions.first?.resolvedPath)
            _ = try Self.updateAgentFixture(agentId: "skill-trust-proof") { entry in
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
                _ = try Self.updateAgentFixture(agentId: "skill-trust-proof") { entry in
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

    private enum FixtureError: Error { case saveRejected }

    private static func updateAgentFixture(
        agentId: String,
        mutate: (inout ExecApprovalsAgent) -> Void) -> Result<Void, FixtureError>
    {
        var snapshot = ExecApprovalsStore.readSnapshot()
        var agents = snapshot.file.agents ?? [:]
        var agent = agents[agentId] ?? ExecApprovalsAgent()
        mutate(&agent)
        agents[agentId] = agent
        snapshot.file.agents = agents
        guard case .saved = ExecApprovalsStore.saveFile(snapshot.file, ifBaseHash: snapshot.hash) else {
            return .failure(.saveRejected)
        }
        return .success(())
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
