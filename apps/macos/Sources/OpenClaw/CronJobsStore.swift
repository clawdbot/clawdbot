import Foundation
import Observation
import OpenClawKit
import OpenClawProtocol
import OSLog

@MainActor
@Observable
final class CronJobsStore {
    enum Consumer: Hashable {
        case statusMenu
        case settings
    }

    static let shared = CronJobsStore()

    var jobs: [CronJob] = []
    var selectedJobId: String?
    var runEntries: [CronRunLogEntry] = []

    var schedulerEnabled: Bool?
    var schedulerStorePath: String?
    var schedulerNextWakeAtMs: Int?

    var isLoadingJobs = false
    var isLoadingRuns = false
    var lastError: String?
    var statusMessage: String?

    @ObservationIgnored private var consumers: Set<Consumer> = []
    private let logger = Logger(subsystem: "ai.openclaw", category: "cron.ui")
    private var refreshTask: Task<Void, Never>?
    private var runsTask: Task<Void, Never>?
    private var eventTask: Task<Void, Never>?
    private var pollTask: Task<Void, Never>?
    private var runsGeneration: UInt64 = 0
    private var jobsGeneration: UInt64 = 0

    private let gateway: GatewayConnection
    private let interval: TimeInterval = 30
    private let isPreview: Bool

    init(gateway: GatewayConnection = .shared, isPreview: Bool = ProcessInfo.processInfo.isPreview) {
        self.gateway = gateway
        self.isPreview = isPreview
    }

    func start(_ consumer: Consumer) {
        guard !self.isPreview, self.consumers.insert(consumer).inserted else { return }
        guard self.eventTask == nil else {
            self.scheduleRefresh(delayMs: 0)
            return
        }
        self.eventTask = Task { [weak self, gateway] in
            for await push in await gateway.subscribe() {
                guard !Task.isCancelled, let self else { return }
                self.handle(push: push)
            }
        }
        SimpleTaskSupport.startDetachedLoop(task: &self.pollTask, interval: self.interval) { [weak self] in
            await self?.refreshJobs()
        }
    }

    func stop(_ consumer: Consumer) {
        self.consumers.remove(consumer)
        // Settings owns history; either visible surface can keep job updates alive.
        if consumer == .settings || self.consumers.isEmpty {
            self.invalidateRuns()
        }
        guard self.consumers.isEmpty else { return }
        self.jobsGeneration &+= 1
        self.isLoadingJobs = false
        SimpleTaskSupport.stop(task: &self.refreshTask)
        SimpleTaskSupport.stop(task: &self.eventTask)
        SimpleTaskSupport.stop(task: &self.pollTask)
    }

    func refreshJobs() async {
        guard !self.isLoadingJobs, !Task.isCancelled else { return }
        // Manual and scheduled refreshes share the active consumers' lifetime; the final
        // stop also invalidates callers whose task is not owned by this store.
        self.jobsGeneration &+= 1
        let generation = self.jobsGeneration
        self.isLoadingJobs = true
        self.lastError = nil
        self.statusMessage = nil
        defer {
            if self.jobsGeneration == generation { self.isLoadingJobs = false }
        }

        do {
            let status = try? await self.gateway.cronStatus()
            guard self.jobsGeneration == generation, !Task.isCancelled else { return }
            let jobs = try await self.gateway.cronList(includeDisabled: true)
            guard self.jobsGeneration == generation, !Task.isCancelled else { return }
            if let status {
                self.schedulerEnabled = status.enabled
                self.schedulerStorePath = status.sqlitePath ?? status.storePath
                self.schedulerNextWakeAtMs = status.nextWakeAtMs
            }
            self.jobs = jobs
            if let selectedJobId = self.selectedJobId,
               !self.jobs.contains(where: { $0.id == selectedJobId })
            {
                self.clearSelectedJob()
            }
            if self.jobs.isEmpty {
                self.statusMessage = "No cron jobs yet."
            }
        } catch {
            guard self.jobsGeneration == generation, !Task.isCancelled else { return }
            self.logger.error("cron.list failed \(error.localizedDescription, privacy: .public)")
            self.lastError = error.localizedDescription
        }
    }

    func selectJob(_ id: String) {
        if self.selectedJobId != id {
            self.selectedJobId = id
            self.runEntries = []
        }
        self.refreshRuns(jobId: id)
    }

    func refreshRuns(jobId: String, limit: Int = 200, delay: TimeInterval = 0) {
        guard self.selectedJobId == jobId else { return }
        // Claim before scheduling so late completions cannot own a newer selection.
        self.runsGeneration &+= 1
        let generation = self.runsGeneration
        self.isLoadingRuns = true
        self.lastError = nil
        SimpleTaskSupport.schedule(task: &self.runsTask, delay: delay) { [weak self] in
            guard let self, self.ownsRunsRequest(generation, jobId: jobId) else { return }
            do {
                let entries = try await self.gateway.cronRuns(jobId: jobId, limit: limit)
                guard self.ownsRunsRequest(generation, jobId: jobId) else { return }
                self.runEntries = entries
            } catch {
                guard self.ownsRunsRequest(generation, jobId: jobId) else { return }
                self.logger.error("cron.runs failed \(error.localizedDescription, privacy: .public)")
                self.lastError = error.localizedDescription
            }
            self.isLoadingRuns = false
            self.runsTask = nil
        }
    }

    func runJob(id: String, force: Bool = true) async {
        do {
            try await self.gateway.cronRun(jobId: id, force: force)
        } catch {
            self.lastError = error.localizedDescription
        }
    }

    func removeJob(id: String) async {
        do {
            try await self.gateway.cronRemove(jobId: id)
            if self.selectedJobId == id {
                self.clearSelectedJob()
            }
            await self.refreshJobs()
        } catch {
            self.lastError = error.localizedDescription
        }
    }

    func setJobEnabled(id: String, enabled: Bool) async {
        do {
            try await self.gateway.cronUpdate(
                jobId: id,
                patch: ["enabled": AnyCodable(enabled)])
            await self.refreshJobs()
        } catch {
            self.lastError = error.localizedDescription
        }
    }

    func upsertJob(
        id: String?,
        payload: [String: AnyCodable]) async throws
    {
        if let id {
            try await self.gateway.cronUpdate(jobId: id, patch: payload)
        } else {
            try await self.gateway.cronAdd(payload: payload)
        }
        await self.refreshJobs()
    }

    // MARK: - Gateway events

    private func handle(push: GatewayPush) {
        switch push {
        case let .event(evt) where evt.event == "cron":
            guard let payload = evt.payload else { return }
            if let cronEvt = try? GatewayPayloadDecoding.decode(payload, as: CronEvent.self) {
                self.handle(cronEvent: cronEvt)
            }
        case .seqGap:
            self.scheduleRefresh()
        default:
            break
        }
    }

    private func handle(cronEvent evt: CronEvent) {
        // Keep UI in sync with the gateway scheduler.
        self.scheduleRefresh(delayMs: 250)
        if self.consumers.contains(.settings), evt.action == "finished",
           let selected = self.selectedJobId, selected == evt.jobId
        {
            self.refreshRuns(jobId: selected, delay: 0.2)
        }
    }

    private func scheduleRefresh(delayMs: Int = 250) {
        let previousTask = self.refreshTask
        previousTask?.cancel()
        self.refreshTask = Task { [weak self] in
            // Even a canceled debounce must drain its predecessor before a replacement can refresh.
            await previousTask?.value
            guard await SimpleTaskSupport.waitForNextOperation(interval: TimeInterval(delayMs) / 1000) else { return }
            await self?.refreshJobs()
        }
    }

    private func clearSelectedJob() {
        self.invalidateRuns()
        self.selectedJobId = nil
        self.runEntries = []
    }

    private func ownsRunsRequest(_ generation: UInt64, jobId: String) -> Bool {
        self.runsGeneration == generation && self.selectedJobId == jobId && !Task.isCancelled
    }

    private func invalidateRuns() {
        self.runsGeneration &+= 1
        SimpleTaskSupport.stop(task: &self.runsTask)
        self.isLoadingRuns = false
    }
}

#if DEBUG
extension CronJobsStore {
    /// Screenshot/demo helper (OPENCLAW_DEBUG_MENU_FIXTURES=1): synthetic jobs
    /// so menu captures show populated automation rows without a gateway.
    func seedDebugFixtureJobs() {
        let now = Int(Date().timeIntervalSince1970 * 1000)
        func job(_ id: String, _ name: String, nextInMinutes: Int) -> CronJob {
            CronJob(
                id: id,
                agentId: nil,
                name: name,
                description: nil,
                enabled: true,
                deleteAfterRun: nil,
                createdAtMs: now,
                updatedAtMs: now,
                schedule: .at(at: "2099-01-01T00:00:00Z"),
                sessionTarget: CronSessionTarget.main,
                wakeMode: .now,
                payload: .systemEvent(text: "fixture"),
                delivery: nil,
                state: CronJobState(nextRunAtMs: now + nextInMinutes * 60000))
        }
        self.jobs = [
            job("fixture-1", "Morning Brief", nextInMinutes: 13),
            job("fixture-2", "Inbox Sweep With A Deliberately Long Name", nextInMinutes: 180),
            job("fixture-3", "Weekly Digest", nextInMinutes: 720),
        ]
    }
}
#endif
