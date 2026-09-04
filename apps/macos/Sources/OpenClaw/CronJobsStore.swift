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

    enum Source: Hashable {
        case gateway(GatewayConnection.ServerLease)
        case primary(revision: UInt64)
        case preview
    }

    struct JobContext: Identifiable {
        let job: CronJob
        let source: Source

        struct ID: Hashable {
            let jobID: String
            let source: Source
        }

        var id: ID {
            ID(jobID: self.job.id, source: self.source)
        }

        var editor: EditorContext {
            EditorContext(job: self.job, source: self.source)
        }
    }

    @Observable
    final class EditorContext: Identifiable {
        let job: CronJob?
        let source: Source
        var isSaving = false
        var error: String?

        init(job: CronJob?, source: Source) {
            self.job = job
            self.source = source
        }
    }

    struct Snapshot {
        let source: Source
        let jobs: [CronJob]
        let status: GatewayConnection.CronSchedulerStatus?

        var rows: [JobContext] {
            self.jobs.map { JobContext(job: $0, source: self.source) }
        }
    }

    static let shared = CronJobsStore()

    private var cachedSnapshot: Snapshot?
    var snapshot: Snapshot? {
        let revision = self.gateway.selectedEndpointRevision
        guard let cachedSnapshot else { return nil }
        // Closing both surfaces keeps same-route cache, but misses retirement receipts.
        // Check its owner before either surface can expose it again.
        if case let .gateway(lease) = cachedSnapshot.source {
            guard lease.endpointRevision == revision,
                  self.gateway.serverLeaseMatchesCurrentRoute(lease) else { return nil }
        }
        return cachedSnapshot
    }

    private var selection: JobContext?
    var jobs: [CronJob] {
        self.snapshot?.jobs ?? []
    }

    var selectedJob: JobContext? {
        guard let selection, self.snapshot?.source == selection.source,
              self.jobs.contains(where: { $0.id == selection.job.id }) else { return nil }
        return selection
    }

    var selectedJobId: String? {
        self.selection?.job.id
    }

    var runEntries: [CronRunLogEntry] = []

    var schedulerEnabled: Bool? {
        self.snapshot?.status?.enabled
    }

    var schedulerStorePath: String? {
        self.snapshot?.status?.sqlitePath ?? self.snapshot?.status?.storePath
    }

    var schedulerNextWakeAtMs: Int? {
        self.snapshot?.status?.nextWakeAtMs
    }

    var isLoadingJobs = false
    var isLoadingRuns = false
    private var errorPublication: (revision: UInt64?, message: String)?
    var lastError: String? {
        get {
            // A failed connection may never produce a lease. Observe its selected
            // endpoint so the old error disappears even when the replacement is offline.
            let revision = self.gateway.selectedEndpointRevision
            guard let errorPublication, errorPublication.revision == revision else { return nil }
            return errorPublication.message
        }
        set {
            self.errorPublication = newValue.map { (self.gateway.selectedEndpointRevision, $0) }
        }
    }

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
    private let endpointRevision: @Sendable () -> UInt64
    private let interval: TimeInterval = 30
    private let isPreview: Bool

    init(
        gateway: GatewayConnection = .shared,
        isPreview: Bool = ProcessInfo.processInfo.isPreview,
        endpointRevision: @escaping @Sendable () -> UInt64 = { GatewayEndpointStore.shared.routeRevision })
    {
        self.gateway = gateway
        self.isPreview = isPreview
        self.endpointRevision = endpointRevision
    }

    func start(_ consumer: Consumer) {
        guard !self.isPreview, self.consumers.insert(consumer).inserted else { return }
        guard self.eventTask == nil else {
            self.scheduleRefresh(delayMs: 0)
            return
        }
        self.eventTask = Task { [weak self, gateway] in
            for await delivery in await gateway.subscribe() {
                guard !Task.isCancelled, let self else { return }
                self.handle(delivery: delivery)
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
        let sourceRevision = self.gateway.selectedEndpointRevision
        self.isLoadingJobs = true
        self.lastError = nil
        self.statusMessage = nil
        defer {
            if self.jobsGeneration == generation { self.isLoadingJobs = false }
        }

        var requestLease: GatewayConnection.ServerLease?
        do {
            let lease = try await self.gateway.acquireServerLease()
            requestLease = lease
            guard self.ownsJobsRequest(generation, lease: lease) else { return }
            _ = self.adoptSource(lease)
            let status = try? await self.gateway.cronStatus(ifCurrentServerLease: lease)
            guard self.ownsJobsRequest(generation, lease: lease) else { return }
            let jobs = try await self.gateway.cronList(includeDisabled: true, ifCurrentServerLease: lease)
            guard self.ownsJobsRequest(generation, lease: lease) else { return }
            self.cachedSnapshot = Snapshot(source: .gateway(lease), jobs: jobs, status: status)
            if let selectedID = self.selectedJobId {
                if let replacement = self.snapshot?.rows.first(where: { $0.job.id == selectedID }) {
                    let reconnected = self.selection?.source != replacement.source
                    self.selection = replacement
                    if reconnected, self.consumers.contains(.settings) { self.refreshRuns(replacement) }
                } else {
                    self.clearSelectedJob()
                }
            }
            if jobs.isEmpty {
                self.statusMessage = String(localized: "No cron jobs yet.")
            }
        } catch {
            guard self.jobsGeneration == generation, !Task.isCancelled,
                  requestLease.map(self.gateway.serverLeaseMatchesCurrentState) ??
                  (self.gateway.selectedEndpointRevision == sourceRevision)
            else { return }
            self.logger.error("cron.list failed \(error.localizedDescription, privacy: .public)")
            self.errorPublication = (requestLease?.endpointRevision ?? sourceRevision, error.localizedDescription)
        }
    }

    func selectJob(_ context: JobContext) {
        guard self.acceptReadSource(from: context.source) else { return }
        if self.selectedJob?.id != context.id {
            self.selection = context
            self.runEntries = []
        }
        self.refreshRuns(context)
    }

    func refreshRuns(_ context: JobContext, limit: Int = 200, delay: TimeInterval = 0) {
        guard self.selectedJob?.id == context.id, self.acceptReadSource(from: context.source),
              case let .gateway(lease) = context.source
        else { return }
        self.runsGeneration &+= 1
        let generation = self.runsGeneration
        self.isLoadingRuns = true
        self.lastError = nil
        SimpleTaskSupport.schedule(task: &self.runsTask, delay: delay) { [weak self] in
            guard let self else { return }
            // Source changes suppress publication; the task still clears its own loading state.
            defer {
                if self.runsGeneration == generation {
                    self.isLoadingRuns = false
                    self.runsTask = nil
                }
            }
            guard self.ownsRunsRequest(generation, context: context) else { return }
            do {
                let entries = try await self.gateway.cronRuns(
                    jobId: context.job.id, limit: limit, ifCurrentServerLease: lease)
                guard self.ownsRunsRequest(generation, context: context) else { return }
                self.runEntries = entries
            } catch {
                guard self.ownsRunsRequest(generation, context: context) else { return }
                self.logger.error("cron.runs failed \(error.localizedDescription, privacy: .public)")
                self.errorPublication = (lease.endpointRevision, error.localizedDescription)
            }
        }
    }

    func openTranscript(_ context: JobContext, using manager: WebChatManager = .shared) {
        guard case let .gateway(lease) = context.source, let key = context.job.transcriptSessionKey else { return }
        let paneSource = self.cachedSnapshot?.source
        manager.show(sessionKey: key, ifCurrentRouteFrom: lease) { [weak self] in
            guard let self else { return }
            guard self.cachedSnapshot?.source == paneSource else {
                self.logger.info("Cron transcript admission superseded by a Gateway change")
                return
            }
            self.lastError = self.changedGatewayError().localizedDescription
        }
    }

    func newEditor() -> EditorContext {
        // Drafting works while offline. Freeze the selected logical source now;
        // Save may recover that source, but may not acquire a later selection.
        EditorContext(job: nil, source: self.isPreview ? .preview : .primary(revision: self.endpointRevision()))
    }

    func runJob(_ context: JobContext, force: Bool = true) async {
        await self.mutate(source: context.source) { route in
            try await self.gateway.cronRun(jobId: context.job.id, force: force, ifCurrentRoute: route)
        }
    }

    func removeJob(_ context: JobContext) async {
        await self.mutate(source: context.source) { route in
            try await self.gateway.cronRemove(jobId: context.job.id, ifCurrentRoute: route)
            if self.selectedJob?.id == context.id { self.clearSelectedJob() }
        }
    }

    func setJobEnabled(_ context: JobContext, enabled: Bool) async {
        await self.mutate(source: context.source) { route in
            try await self.gateway.cronUpdate(
                jobId: context.job.id, patch: ["enabled": AnyCodable(enabled)], ifCurrentRoute: route)
        }
    }

    func upsertJob(_ context: EditorContext, payload: [String: AnyCodable]) async throws {
        let lease: GatewayConnection.ServerLease
        if case let .primary(revision) = context.source {
            guard self.endpointRevision() == revision else { throw self.changedGatewayError() }
            do {
                lease = try await self.gateway.acquireServerLease()
            } catch {
                throw self.endpointRevision() == revision ? error : self.changedGatewayError()
            }
            guard self.endpointRevision() == revision, lease.endpointRevision == revision,
                  self.gateway.serverLeaseMatchesCurrentState(lease)
            else { throw self.changedGatewayError() }
        } else {
            lease = try self.requireCurrentActionSource(context.source)
        }
        do {
            if let job = context.job {
                try await self.gateway.cronUpdate(jobId: job.id, patch: payload, ifCurrentRoute: lease.route)
            } else {
                try await self.gateway.cronAdd(payload: payload, ifCurrentRoute: lease.route)
            }
            guard self.gateway.serverLeaseMatchesCurrentRoute(lease) else { throw self.changedGatewayError() }
            await self.refreshJobs()
        } catch {
            throw self.gateway.serverLeaseMatchesCurrentRoute(lease) ? error : self.changedGatewayError()
        }
    }

    private func mutate(
        source: Source,
        operation: (GatewayConnection.Route) async throws -> Void) async
    {
        let lease: GatewayConnection.ServerLease
        do {
            lease = try self.requireCurrentActionSource(source)
        } catch {
            self.lastError = error.localizedDescription
            return
        }
        let paneSource = self.cachedSnapshot?.source
        var failure: Error?
        do {
            try await operation(lease.route)
        } catch {
            failure = error
        }
        // Dispatch can discover an external edit before this pane reloads.
        // Show that rejection here, but never repaint a replacement pane.
        guard self.gateway.serverLeaseMatchesCurrentRoute(lease) else {
            if self.cachedSnapshot?.source == paneSource {
                self.lastError = self.changedGatewayError().localizedDescription
            } else {
                self.logger.info("Cron action completion superseded by a Gateway change")
            }
            return
        }
        if let failure {
            self.errorPublication = (lease.endpointRevision, failure.localizedDescription)
        } else {
            await self.refreshJobs()
        }
    }

    private func isCurrentReadSource(_ source: Source) -> Bool {
        guard case let .gateway(lease) = source else { return false }
        return self.gateway.serverLeaseMatchesCurrentState(lease)
    }

    private func requireCurrentActionSource(_ source: Source) throws -> GatewayConnection.ServerLease {
        guard case let .gateway(lease) = source, self.gateway.serverLeaseMatchesCurrentRoute(lease) else {
            throw self.changedGatewayError()
        }
        return lease
    }

    private func acceptReadSource(from source: Source) -> Bool {
        guard self.isCurrentReadSource(source) else {
            self.lastError = self.changedGatewayError().localizedDescription
            return false
        }
        return true
    }

    private func changedGatewayError() -> NSError {
        NSError(domain: "Cron", code: 1, userInfo: [NSLocalizedDescriptionKey:
                "The Gateway changed. Refresh and reopen the cron job before trying again."])
    }

    // MARK: - Gateway events

    private func handle(delivery: GatewayConnection.PushDelivery) {
        if delivery.push == nil {
            guard self.cachedSnapshot?.source == .gateway(delivery.serverLease) else { return }
            self.retireSource()
            return
        }
        guard delivery.isCurrent, let push = delivery.push else { return }
        if self.adoptSource(delivery.serverLease) {
            self.jobsGeneration &+= 1
            self.isLoadingJobs = false
            self.scheduleRefresh(delayMs: 0)
        }
        switch push {
        case .snapshot:
            self.scheduleRefresh(delayMs: 0)
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
           let selected = self.selectedJob, selected.job.id == evt.jobId
        {
            self.refreshRuns(selected, delay: 0.2)
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
        self.selection = nil
        self.runEntries = []
    }

    private func ownsRunsRequest(_ generation: UInt64, context: JobContext) -> Bool {
        self.runsGeneration == generation && self.selectedJob?.id == context.id &&
            self.isCurrentReadSource(context.source) && !Task.isCancelled
    }

    private func ownsJobsRequest(_ generation: UInt64, lease: GatewayConnection.ServerLease) -> Bool {
        self.jobsGeneration == generation && self.gateway.serverLeaseMatchesCurrentState(lease) && !Task.isCancelled
    }

    private func adoptSource(_ lease: GatewayConnection.ServerLease) -> Bool {
        guard self.cachedSnapshot?.source != .gateway(lease) else { return false }
        // Keep only same-Primary selection intent across socket recovery. The
        // old row stays hidden until this hello's fresh list replaces its lease.
        if case let .gateway(previous) = self.selection?.source,
           let revision = previous.endpointRevision, revision == lease.endpointRevision
        {
            self.invalidateRuns()
            self.runEntries = []
        } else {
            self.clearSelectedJob()
        }
        self.cachedSnapshot = Snapshot(source: .gateway(lease), jobs: [], status: nil)
        self.lastError = nil
        self.statusMessage = nil
        return true
    }

    private func retireSource() {
        self.jobsGeneration &+= 1
        self.isLoadingJobs = false
        SimpleTaskSupport.stop(task: &self.refreshTask)
        self.invalidateRuns()
        self.runEntries = []
        self.cachedSnapshot = nil
        self.lastError = nil
        self.statusMessage = "Gateway disconnected. Reconnect to load cron jobs."
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
        self.seedPreviewJobs([
            job("fixture-1", "Morning Brief", nextInMinutes: 13),
            job("fixture-2", "Inbox Sweep With A Deliberately Long Name", nextInMinutes: 180),
            job("fixture-3", "Weekly Digest", nextInMinutes: 720),
        ])
    }

    func seedPreviewJobs(_ jobs: [CronJob], selectedJobID: String? = nil, enabled: Bool = true) {
        self.cachedSnapshot = Snapshot(source: .preview, jobs: jobs, status: .init(
            enabled: enabled, storePath: "", sqlitePath: nil, jobs: jobs.count, nextWakeAtMs: nil))
        self.selection = self.snapshot?.rows.first { $0.job.id == selectedJobID }
    }
}
#endif
