import Foundation
import Testing
@testable import OpenClaw
@testable import OpenClawKit

private struct CronGatewayRequest: Sendable {
    let id: String
    let method: String
    let jobId: String?
}

private actor CronGatewayRequestLog {
    private var requests: [CronGatewayRequest] = []
    private var endpointLookups = 0
    private var availableJobs = ["job-a", "job-b"]
    private var nextEventSequence = 0

    func append(_ request: CronGatewayRequest) {
        self.requests.append(request)
    }

    func lookupEndpoint() {
        self.endpointLookups += 1
    }

    func endpointLookupCount() -> Int {
        self.endpointLookups
    }

    func request(method: String, jobId: String?, occurrence: Int = 0) -> CronGatewayRequest? {
        let matches = self.requests.filter { $0.method == method && $0.jobId == jobId }
        guard matches.indices.contains(occurrence) else { return nil }
        return matches[occurrence]
    }

    func requestCount(method: String, jobId: String? = nil) -> Int {
        self.requests.count { $0.method == method && (jobId == nil || $0.jobId == jobId) }
    }

    func removeJob(_ jobId: String) {
        self.availableJobs.removeAll { $0 == jobId }
    }

    func jobsResponse() -> String {
        let jobs = self.availableJobs.map { jobId in
            #"{"id":"\#(jobId)","name":"\#(jobId)","enabled":true,"createdAtMs":0,"updatedAtMs":0,"# +
                #""schedule":{"kind":"every","everyMs":1000},"sessionTarget":"isolated","wakeMode":"now","# +
                #""payload":{"kind":"systemEvent","text":"test"},"state":{}}"#
        }.joined(separator: ",")
        return #"{"jobs":[\#(jobs)]}"#
    }

    func eventSequence() -> Int {
        self.nextEventSequence += 1
        return self.nextEventSequence
    }
}

private final class CronGatewayFixture: @unchecked Sendable {
    let requests: CronGatewayRequestLog
    let session: GatewayTestWebSocketSession
    let gateway: GatewayConnection

    init(
        recoveryEligible: Bool = false,
        initialRunsFailure: (any Error & Sendable)? = nil,
        holdJobList: Bool = false,
        onRequestRecorded: (@Sendable () -> Void)? = nil)
    {
        let requests = CronGatewayRequestLog()
        self.requests = requests
        self.session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { socket, message, sendIndex in
                guard sendIndex > 0,
                      let request = Self.decodeRequest(message)
                else { return }
                await requests.append(request)
                onRequestRecorded?()
                guard request.method != "cron.runs" else {
                    if let initialRunsFailure,
                       await requests.requestCount(method: "cron.runs") == 1
                    {
                        throw initialRunsFailure
                    }
                    return
                }
                let payload: String
                switch request.method {
                case "cron.status":
                    payload = #"{"enabled":true,"storePath":"/tmp/cron-tests","jobs":2}"#
                case "cron.list":
                    if holdJobList { return }
                    payload = await requests.jobsResponse()
                case "cron.remove":
                    if let jobId = request.jobId {
                        await requests.removeJob(jobId)
                    }
                    payload = #"{"ok":true}"#
                default:
                    payload = #"{"ok":true}"#
                }
                socket.emitReceiveSuccess(.data(Data(
                    #"{"type":"res","id":"\#(request.id)","ok":true,"payload":\#(payload)}"#.utf8)))
            })
        })
        if recoveryEligible {
            self.gateway = GatewayConnection(
                endpointProvider: {
                    await requests.lookupEndpoint()
                    return GatewayConnection.EndpointSnapshot(
                        config: (url: URL(string: "ws://127.0.0.1:1")!, token: nil, password: nil),
                        routeAuthority: nil)
                },
                supportsSharedEndpointRecovery: true,
                activationBindingKeyProvider: { nil },
                sessionBox: WebSocketSessionBox(session: self.session))
        } else {
            self.gateway = GatewayConnection(
                configProvider: {
                    await requests.lookupEndpoint()
                    return (url: URL(string: "ws://127.0.0.1:1")!, token: nil, password: nil)
                },
                sessionBox: WebSocketSessionBox(session: self.session))
        }
    }

    private static func decodeRequest(_ message: URLSessionWebSocketTask.Message) -> CronGatewayRequest? {
        let data: Data? = switch message {
        case let .data(data): data
        case let .string(value): value.data(using: .utf8)
        @unknown default: nil
        }
        guard let data,
              let frame = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let id = frame["id"] as? String,
              let method = frame["method"] as? String
        else { return nil }
        let parameters = frame["params"] as? [String: Any]
        return CronGatewayRequest(id: id, method: method, jobId: parameters?["id"] as? String)
    }

    func waitForRequest(
        method: String = "cron.runs",
        jobId: String? = nil,
        occurrence: Int = 0,
        timeout: Duration = .seconds(2)) async -> CronGatewayRequest?
    {
        let deadline = ContinuousClock.now + timeout
        while ContinuousClock.now < deadline {
            if let request = await self.requests.request(method: method, jobId: jobId, occurrence: occurrence) {
                return request
            }
            try? await Task.sleep(for: .milliseconds(2))
        }
        return await self.requests.request(method: method, jobId: jobId, occurrence: occurrence)
    }

    func respond(
        to request: CronGatewayRequest,
        jobId: String,
        summary: String = "completed") async throws
    {
        let socket = try await self.readySocket()
        let response = #"{"type":"res","id":"\#(request.id)","ok":true,"payload":{"entries":["# +
            #"{"ts":1700000000000,"jobId":"\#(jobId)","action":"finished","# +
            #""status":"ok","summary":"\#(summary)"}]}}"#
        socket.emitReceiveSuccessOnce(.data(Data(response.utf8)))
    }

    func fail(_ request: CronGatewayRequest, message: String) async throws {
        let socket = try await self.readySocket()
        let response = #"{"type":"res","id":"\#(request.id)","ok":false,"# +
            #""error":{"code":"INVALID_REQUEST","message":"\#(message)"}}"#
        socket.emitReceiveSuccessOnce(.data(Data(response.utf8)))
    }

    func respondWithJobs(to request: CronGatewayRequest) async throws {
        let socket = try await self.readySocket()
        let payload = await self.requests.jobsResponse()
        let response = #"{"type":"res","id":"\#(request.id)","ok":true,"payload":\#(payload)}"#
        socket.emitReceiveSuccessOnce(.data(Data(response.utf8)))
    }

    func sendFinishedEvent(jobId: String) async throws {
        let socket = try await self.readySocket()
        let sequence = await self.requests.eventSequence()
        let event = #"{"type":"event","event":"cron","seq":\#(sequence),"# +
            #""payload":{"jobId":"\#(jobId)","action":"finished"}}"#
        socket.emitReceiveSuccessOnce(.data(Data(event.utf8)))
    }

    private func readySocket() async throws -> GatewayTestWebSocketTask {
        let deadline = ContinuousClock.now + .seconds(2)
        while ContinuousClock.now < deadline {
            if let socket = self.session.latestTask(), socket.hasPendingReceiveHandler() {
                return socket
            }
            try? await Task.sleep(for: .milliseconds(2))
        }
        return try #require(self.session.latestTask())
    }
}

@Suite(.serialized)
@MainActor
struct CronJobsStoreTests {
    @Test(arguments: [false, true])
    func `stopping the pane rejects a late job list completion`(succeeds: Bool) async throws {
        let (arrivals, signal) = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
        let fixture = CronGatewayFixture(holdJobList: true, onRequestRecorded: { signal.yield(()) })
        let store = CronJobsStore(gateway: fixture.gateway)
        let refresh = Task {
            defer { signal.finish() }
            await store.refreshJobs()
        }
        func cleanup() async {
            store.stop()
            refresh.cancel()
            signal.finish()
            await refresh.value
            await fixture.gateway.shutdown()
        }
        do {
            var recorded: CronGatewayRequest?
            for await _ in arrivals {
                recorded = await fixture.requests.request(method: "cron.list", jobId: nil)
                if recorded != nil { break }
            }
            let pending = try #require(recorded, "refresh ended before cron.list arrived")
            // A buffered request can outlive its refresh; stop must still precede completion.
            try #require(store.isLoadingJobs)
            store.stop()
            store.lastError = "current pane error"
            if succeeds {
                try await fixture.respondWithJobs(to: pending)
            } else {
                try await fixture.fail(pending, message: "stopped pane failure")
            }
            await refresh.value

            #expect(store.lastError == "current pane error")
            #expect(store.jobs.isEmpty)
            #expect(store.schedulerEnabled == nil)
            #expect(!store.isLoadingJobs)
        } catch {
            await cleanup()
            throw error
        }
        await cleanup()
    }

    @Test func `selecting another job sends its history request while the previous request is pending`() async throws {
        let fixture = CronGatewayFixture()
        let store = CronJobsStore(gateway: fixture.gateway)
        defer { store.stop() }
        store.selectJob("job-a")
        let firstRequest = try #require(await fixture.waitForRequest(jobId: "job-a"))
        store.runEntries = [self.entry(jobId: "job-a", summary: "old A")]
        store.lastError = "old A error"

        store.selectJob("job-b")

        #expect(store.selectedJobId == "job-b")
        #expect(store.runEntries.isEmpty)
        #expect(store.lastError == nil)
        #expect(store.isLoadingRuns)
        let secondRequest = try #require(await fixture.waitForRequest(jobId: "job-b"))
        try await fixture.respond(to: secondRequest, jobId: "job-b", summary: "current B")
        try #require(await self.waitUntil { !store.isLoadingRuns })
        #expect(store.runEntries.map(\.jobId) == ["job-b"])
        #expect(store.runEntries.first?.summary == "current B")

        try await fixture.respond(to: firstRequest, jobId: "job-a", summary: "stale A")
        await Task.yield()

        #expect(store.runEntries.map(\.jobId) == ["job-b"])
        #expect(store.runEntries.first?.summary == "current B")
        #expect(!store.isLoadingRuns)
        #expect(store.lastError == nil)
        #expect(fixture.session.snapshotMakeCount() == 1)
        #expect(fixture.session.snapshotCancelCount() == 0)
        #expect(await fixture.requests.endpointLookupCount() == 2)
    }

    @Test func `late failure from a superseded job preserves the selected jobs own failure`() async throws {
        let fixture = CronGatewayFixture()
        let store = CronJobsStore(gateway: fixture.gateway)
        defer { store.stop() }
        store.selectJob("job-a")
        let firstRequest = try #require(await fixture.waitForRequest(jobId: "job-a"))
        store.runEntries = [self.entry(jobId: "job-a", summary: "old A")]

        store.selectJob("job-b")
        #expect(store.runEntries.isEmpty)
        let selectedRequest = try #require(await fixture.waitForRequest(jobId: "job-b"))
        try await fixture.fail(selectedRequest, message: "selected job B failed")
        try #require(await self.waitUntil { !store.isLoadingRuns })
        let selectedError = try #require(store.lastError)
        #expect(selectedError.contains("selected job B failed"))
        #expect(store.runEntries.isEmpty)

        try await fixture.fail(firstRequest, message: "stale job A failed")
        await Task.yield()

        #expect(store.selectedJobId == "job-b")
        #expect(store.runEntries.isEmpty)
        #expect(store.lastError == selectedError)
        #expect(!store.isLoadingRuns)
    }

    @Test
    func `manual refresh replaces the selected jobs pending request without accepting stale success`() async throws {
        let fixture = CronGatewayFixture()
        let store = CronJobsStore(gateway: fixture.gateway)
        defer { store.stop() }
        store.selectJob("job-a")
        let originalRequest = try #require(await fixture.waitForRequest(jobId: "job-a"))

        store.refreshRuns(jobId: "job-a")

        let replacement = try #require(await fixture.waitForRequest(jobId: "job-a", occurrence: 1))
        #expect(store.isLoadingRuns)
        try await fixture.fail(replacement, message: "manual refresh failed")
        try #require(await self.waitUntil { !store.isLoadingRuns })
        let replacementError = try #require(store.lastError)

        try await fixture.respond(to: originalRequest, jobId: "job-a", summary: "stale manual result")
        await Task.yield()

        #expect(store.runEntries.isEmpty)
        #expect(store.lastError == replacementError)
        #expect(!store.isLoadingRuns)
        #expect(fixture.session.snapshotMakeCount() == 1)
        #expect(fixture.session.snapshotCancelCount() == 0)
    }

    @Test func `manual refresh after failure clears the old error and publishes the successful retry`() async throws {
        let fixture = CronGatewayFixture()
        let store = CronJobsStore(gateway: fixture.gateway)
        defer { store.stop() }
        store.selectJob("job-a")
        let failedRequest = try #require(await fixture.waitForRequest(jobId: "job-a"))
        try await fixture.fail(failedRequest, message: "temporary history failure")
        try #require(await self.waitUntil { store.lastError != nil })

        store.refreshRuns(jobId: "job-a")

        #expect(store.lastError == nil)
        #expect(store.isLoadingRuns)
        let retry = try #require(await fixture.waitForRequest(jobId: "job-a", occurrence: 1))
        try await fixture.respond(to: retry, jobId: "job-a", summary: "recovered history")
        try #require(await self.waitUntil { !store.isLoadingRuns })

        #expect(store.runEntries.map(\.jobId) == ["job-a"])
        #expect(store.runEntries.first?.summary == "recovered history")
        #expect(store.lastError == nil)
    }

    @Test func `finished events refresh only the job still selected after their debounce`() async throws {
        let fixture = CronGatewayFixture()
        let store = CronJobsStore(gateway: fixture.gateway)
        defer { store.stop() }
        store.start()
        try #require(await self.waitUntil { store.jobs.count == 2 })
        store.selectJob("job-a")
        let firstRequest = try #require(await fixture.waitForRequest(jobId: "job-a"))
        try await fixture.respond(to: firstRequest, jobId: "job-a")
        try #require(await self.waitUntil { !store.isLoadingRuns })

        try await fixture.sendFinishedEvent(jobId: "job-a")
        try #require(await self.waitUntil { store.isLoadingRuns })
        store.selectJob("job-b")
        let selectedRequest = try #require(await fixture.waitForRequest(jobId: "job-b"))
        try await fixture.respond(to: selectedRequest, jobId: "job-b")
        try #require(await self.waitUntil { !store.isLoadingRuns })

        #expect(await fixture.waitForRequest(
            jobId: "job-a",
            occurrence: 1,
            timeout: .milliseconds(300)) == nil)
        #expect(store.runEntries.map(\.jobId) == ["job-b"])

        try await fixture.sendFinishedEvent(jobId: "job-b")
        let eventRequest = try #require(await fixture.waitForRequest(jobId: "job-b", occurrence: 1))
        try await fixture.respond(to: eventRequest, jobId: "job-b", summary: "event B")
        try #require(await self.waitUntil { !store.isLoadingRuns })

        #expect(store.runEntries.map(\.jobId) == ["job-b"])
        #expect(store.runEntries.first?.summary == "event B")
        #expect(await fixture.requests.requestCount(method: "cron.runs", jobId: "job-a") == 1)
    }

    @Test(arguments: ["selection", "manual", "event"], ["success", "failure"])
    func `stopping the pane rejects late completions from every history entry point`(
        source: String,
        outcome: String) async throws
    {
        let fixture = CronGatewayFixture()
        let store = CronJobsStore(gateway: fixture.gateway)
        defer { store.stop() }
        if source == "event" {
            store.start()
            try #require(await self.waitUntil { store.jobs.count == 2 })
        }
        store.selectJob("job-a")
        var pending = try #require(await fixture.waitForRequest(jobId: "job-a"))
        if source != "selection" {
            try await fixture.respond(to: pending, jobId: "job-a", summary: "existing history")
            try #require(await self.waitUntil { !store.isLoadingRuns })
            if source == "manual" {
                store.refreshRuns(jobId: "job-a")
            } else {
                try await fixture.sendFinishedEvent(jobId: "job-a")
            }
            pending = try #require(await fixture.waitForRequest(jobId: "job-a", occurrence: 1))
        }
        let previousHistory = store.runEntries.map(\.summary)
        let previousError = store.lastError

        store.stop()

        #expect(!store.isLoadingRuns)
        if outcome == "success" {
            try await fixture.respond(to: pending, jobId: "job-a", summary: "late history")
        } else {
            try await fixture.fail(pending, message: "late history failure")
        }
        await Task.yield()

        #expect(store.selectedJobId == "job-a")
        #expect(store.runEntries.map(\.summary) == previousHistory)
        #expect(store.lastError == previousError)
        #expect(!store.isLoadingRuns)
        #expect(fixture.session.snapshotCancelCount() == 0)
    }

    @Test func `removing the selected job cancels its pending history before refreshing jobs`() async throws {
        let fixture = CronGatewayFixture()
        let store = CronJobsStore(gateway: fixture.gateway)
        defer { store.stop() }
        store.selectJob("job-a")
        let pending = try #require(await fixture.waitForRequest(jobId: "job-a"))
        store.runEntries = [self.entry(jobId: "job-a", summary: "removed history")]

        await store.removeJob(id: "job-a")

        #expect(store.selectedJobId == nil)
        #expect(store.runEntries.isEmpty)
        #expect(!store.isLoadingRuns)
        #expect(store.jobs.map(\.id) == ["job-b"])
        try await fixture.respond(to: pending, jobId: "job-a", summary: "late removed job")
        await Task.yield()

        #expect(store.selectedJobId == nil)
        #expect(store.runEntries.isEmpty)
        #expect(store.lastError == nil)
    }

    @Test
    func `job list refresh invalidates pending history when another client removed its selected job`() async throws {
        let fixture = CronGatewayFixture()
        let store = CronJobsStore(gateway: fixture.gateway)
        defer { store.stop() }
        store.selectJob("job-a")
        let pending = try #require(await fixture.waitForRequest(jobId: "job-a"))
        store.runEntries = [self.entry(jobId: "job-a", summary: "old history")]
        await fixture.requests.removeJob("job-a")

        await store.refreshJobs()

        #expect(store.selectedJobId == nil)
        #expect(store.runEntries.isEmpty)
        #expect(!store.isLoadingRuns)
        #expect(store.jobs.map(\.id) == ["job-b"])
        try await fixture.fail(pending, message: "removed job completed late")
        await Task.yield()

        #expect(store.runEntries.isEmpty)
        #expect(store.lastError == nil)
    }

    @Test func `superseded history never activates the local Gateway or its launch agent`() async throws {
        try await self.withLocalGatewayRecovery { fixture in
            let store = CronJobsStore(gateway: fixture.gateway)
            defer { store.stop() }
            store.selectJob("job-a")
            _ = try #require(await fixture.waitForRequest(jobId: "job-a"))

            store.selectJob("job-b")

            let selectedRequest = try #require(await fixture.waitForRequest(jobId: "job-b"))
            try await fixture.respond(to: selectedRequest, jobId: "job-b")
            try #require(await self.waitUntil { !store.isLoadingRuns })

            #expect(store.runEntries.map(\.jobId) == ["job-b"])
            #expect(store.lastError == nil)
            #expect(await fixture.requests.endpointLookupCount() == 2)
            #expect(fixture.session.snapshotMakeCount() == 1)
            #expect(fixture.session.snapshotCancelCount() == 0)
            #expect(GatewayProcessManager.shared.status == .stopped)
            #expect(GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot().isEmpty)
        }
    }

    @Test func `uncancelled history transport failures activate the Gateway and retry`() async throws {
        try await self.withLocalGatewayRecovery(initialRunsFailure: URLError(.networkConnectionLost)) { fixture in
            let store = CronJobsStore(gateway: fixture.gateway)
            defer { store.stop() }

            store.selectJob("job-a")

            _ = try #require(await fixture.waitForRequest(jobId: "job-a"))
            let recoveredRequest = try #require(await fixture.waitForRequest(jobId: "job-a", occurrence: 1))
            #expect(GatewayProcessManager.shared.status != .stopped)
            try await fixture.respond(to: recoveredRequest, jobId: "job-a", summary: "recovered history")
            try #require(await self.waitUntil { !store.isLoadingRuns })

            #expect(store.runEntries.map(\.jobId) == ["job-a"])
            #expect(store.runEntries.first?.summary == "recovered history")
            #expect(store.lastError == nil)
            #expect(await fixture.requests.requestCount(method: "cron.runs", jobId: "job-a") == 2)
        }
    }

    @Test func `starting and stopping retains normal scheduler and job refresh behavior`() async throws {
        let fixture = CronGatewayFixture()
        let store = CronJobsStore(gateway: fixture.gateway)

        store.start()
        try #require(await self.waitUntil { store.jobs.count == 2 })

        #expect(store.schedulerEnabled == true)
        #expect(store.schedulerStorePath == "/tmp/cron-tests")
        #expect(store.jobs.map(\.id) == ["job-a", "job-b"])
        #expect(store.lastError == nil)
        #expect(await fixture.requests.requestCount(method: "cron.status") == 1)
        #expect(await fixture.requests.requestCount(method: "cron.list") == 1)

        store.stop()

        #expect(!store.isLoadingRuns)
        #expect(fixture.session.snapshotCancelCount() == 0)
    }

    private func entry(jobId: String, summary: String) -> CronRunLogEntry {
        CronRunLogEntry(
            ts: 1_700_000_000_000,
            jobId: jobId,
            action: "finished",
            status: "ok",
            error: nil,
            summary: summary,
            runAtMs: nil,
            durationMs: nil,
            nextRunAtMs: nil)
    }

    private func withLocalGatewayRecovery(
        initialRunsFailure: (any Error & Sendable)? = nil,
        _ operation: (CronGatewayFixture) async throws -> Void) async throws
    {
        let isolatedState = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-autoqa-185-cron-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: isolatedState, withIntermediateDirectories: true)
        let configURL = isolatedState.appendingPathComponent("openclaw.json")
        try Data(#"{"gateway":{"mode":"local","port":49185}}"#.utf8).write(to: configURL)
        defer { try? FileManager.default.removeItem(at: isolatedState) }

        try await TestIsolation.withEnvValues([
            "OPENCLAW_CONFIG_PATH": configURL.path,
            "OPENCLAW_STATE_DIR": isolatedState.path,
        ]) {
            try await DeviceIdentityStore.withStateDirectory(isolatedState) {
                let fixture = CronGatewayFixture(
                    recoveryEligible: true,
                    initialRunsFailure: initialRunsFailure)
                let manager = GatewayProcessManager.shared
                let priorMode = AppStateStore.shared.connectionMode
                AppStateStore.shared.connectionMode = .local
                manager._testResetGatewayStartTask()
                manager.setTestingStatus(.stopped)
                manager.setTestingConnection(fixture.gateway)
                manager.setTestingSkipControlChannelRefresh(true)
                GatewayLaunchAgentManager.setTestingDisableLaunchAgentMarkerURL(
                    isolatedState.appendingPathComponent("disable-launch-agent"))
                GatewayLaunchAgentManager.setTestingInterceptDaemonCommands(true)
                GatewayLaunchAgentManager.setTestingDaemonStatusPayload(
                    #"{"ok":true,"service":{"loaded":false}}"#)
                GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()
                defer {
                    manager._testResetGatewayStartTask()
                    manager.setTestingStatus(.stopped)
                    manager.setTestingConnection(nil)
                    manager.setTestingSkipControlChannelRefresh(false)
                    manager.setTestingDesiredActive(false)
                    GatewayLaunchAgentManager.setTestingDisableLaunchAgentMarkerURL(nil)
                    GatewayLaunchAgentManager.setTestingInterceptDaemonCommands(false)
                    GatewayLaunchAgentManager.setTestingDaemonStatusPayload(nil)
                    GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()
                    AppStateStore.shared.connectionMode = priorMode
                }

                do {
                    try await operation(fixture)
                    await fixture.gateway.shutdown()
                } catch {
                    await fixture.gateway.shutdown()
                    throw error
                }
            }
        }
    }

    private func waitUntil(
        timeout: Duration = .seconds(2),
        _ condition: @MainActor () -> Bool) async -> Bool
    {
        let deadline = ContinuousClock.now + timeout
        while ContinuousClock.now < deadline {
            if condition() { return true }
            try? await Task.sleep(for: .milliseconds(2))
        }
        return condition()
    }
}
